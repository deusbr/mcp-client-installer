'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

/**
 * Computes a deterministic SHA-256 digest for any JSON-serializable MCP config entry.
 * @param {unknown} value
 * @returns {string}
 */
function hashValue(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value === undefined ? null : value))
    .digest('hex');
}

/**
 * Escapes a string for safe inclusion inside a regular expression.
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Writes content atomically via a temporary sibling file and rename.
 * @param {string} filename
 * @param {string} content
 */
function atomicWrite(filename, content) {
  const dir = path.dirname(filename);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filename)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, filename);
  } catch (error) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {}
    throw error;
  }
}

/**
 * Returns default MCP client configuration locations across Windows, macOS, and Linux.
 * @param {string} [home]
 * @param {string} [appdata]
 * @param {NodeJS.Platform} [platform]
 */
function knownClients(
  home = os.homedir(),
  appdata = process.env.APPDATA || path.join(home, '.config'),
  platform = process.platform
) {
  const claudeDesktopPath =
    platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : path.join(appdata, 'Claude', 'claude_desktop_config.json');

  return [
    { id: 'claude-desktop', name: 'Claude Desktop', format: 'json', path: claudeDesktopPath },
    { id: 'claude-code', name: 'Claude Code', format: 'json', path: path.join(home, '.claude.json') },
    { id: 'cursor', name: 'Cursor', format: 'json', path: path.join(home, '.cursor', 'mcp.json') },
    {
      id: 'codex',
      name: 'Codex',
      format: 'toml',
      path: path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'config.toml')
    },
    { id: 'custom', name: 'Custom JSON MCP Client', format: 'json', requiresFile: true }
  ];
}

/**
 * Reads an existing config file safely, rejecting symlinks and files over 2 MB.
 * @param {string} filename
 * @returns {string}
 */
function readConfigSafe(filename) {
  if (!fs.existsSync(filename)) return '';
  const st = fs.lstatSync(filename);
  if (!st.isFile() || st.isSymbolicLink() || st.size > 2 * 1024 * 1024) {
    throw new Error('Invalid or oversized MCP client configuration file.');
  }
  return fs.readFileSync(filename, 'utf8');
}

/**
 * Locates TOML table sections belonging to [mcp_servers.<serverName>].
 * @param {string} text
 * @param {string} serverName
 * @returns {Array<[number, number]>}
 */
function tomlSections(text, serverName) {
  const safeName = escapeRegExp(serverName);
  const ownedRe = new RegExp(`^mcp_servers\\.(?:${safeName}|"${safeName}"|'${safeName}')(?:\\.|$)`);
  const lines = text.split(/(?<=\n)/);
  const ranges = [];
  let start = -1;
  let offset = 0;

  for (const line of lines) {
    const header = line.trim().match(/^\[([^\]]+)\]/);
    if (header) {
      const owned = ownedRe.test(header[1]);
      if (start >= 0 && !owned) {
        ranges.push([start, offset]);
        start = -1;
      }
      if (owned && start < 0) start = offset;
    }
    offset += line.length;
  }

  if (start >= 0) ranges.push([start, text.length]);
  return ranges;
}

function getTomlSection(text, serverName) {
  return tomlSections(text, serverName)
    .map(([start, end]) => text.slice(start, end))
    .join('');
}

function replaceTomlSection(text, serverName, entry) {
  let out = text;
  for (const [start, end] of tomlSections(text, serverName).reverse()) {
    out = out.slice(0, start) + out.slice(end);
  }
  if (entry) {
    out = out.trimEnd() + (out.trim() ? '\n\n' : '') + entry.trimEnd() + '\n';
  }
  return out;
}

function formatTomlEntry(serverName, definition) {
  const key = /^[A-Za-z0-9_-]+$/.test(serverName) ? serverName : JSON.stringify(serverName);
  const lines = [
    `[mcp_servers.${key}]`,
    `command = ${JSON.stringify(definition.command)}`,
    `args = ${JSON.stringify(definition.args || [])}`
  ];
  if (definition.env && Object.keys(definition.env).length > 0) {
    lines.push('', `[mcp_servers.${key}.env]`);
    for (const [k, v] of Object.entries(definition.env)) {
      lines.push(`${k} = ${JSON.stringify(String(v))}`);
    }
  }
  return lines.join('\n') + '\n';
}

function createMemoryStore() {
  let state = {};
  return {
    get: () => state,
    set: (next) => {
      state = next || {};
    }
  };
}

class ClientInstaller {
  /**
   * @param {{
   *   serverName: string,
   *   definition: { command: string, args?: string[], env?: Record<string, string> },
   *   stateStore?: { get: () => Record<string, any>, set: (next: Record<string, any>) => void },
   *   clients?: Array<any>
   * }} options
   */
  constructor({ serverName, definition, stateStore = createMemoryStore(), clients = knownClients() }) {
    if (!serverName || !String(serverName).trim()) {
      throw new Error('serverName is required.');
    }
    if (!definition || typeof definition.command !== 'string') {
      throw new Error('definition.command is required.');
    }
    this.serverName = String(serverName).trim();
    this.definition = definition;
    this.stateStore = stateStore;
    this.clients = clients;
  }

  status() {
    const saved = this.stateStore.get() || {};
    return this.clients.map((client) => ({
      id: client.id,
      name: client.name,
      path: client.path || '',
      requiresFile: !!client.requiresFile,
      exists: !!client.path && fs.existsSync(client.path),
      installed: !!saved[client.id],
      installedPath: saved[client.id]?.path || ''
    }));
  }

  locate({ clientId, configFile }) {
    const client = this.clients.find((c) => c.id === clientId);
    if (!client) throw new Error(`Unsupported MCP client: ${clientId}`);
    const target = configFile || client.path;
    if (!target || !path.isAbsolute(target)) {
      throw new Error('An absolute path to the client configuration file is required.');
    }
    return { ...client, path: target };
  }

  async install(input) {
    const client = this.locate(input);
    const text = readConfigSafe(client.path);
    const serverName = input.serverName || this.serverName;
    const definition = input.definition || this.definition;
    const saved = this.stateStore.get() || {};
    const prior = saved[client.id];

    let next;
    let previous;
    let installed;

    if (client.format === 'toml') {
      previous = getTomlSection(text, serverName);
      installed = formatTomlEntry(serverName, definition);
      if (prior && prior.path === client.path && hashValue(previous) !== prior.installedHash) {
        throw new Error('Existing MCP entry was modified outside this installer. Review it before reinstalling.');
      }
      next = replaceTomlSection(text, serverName, installed);
    } else {
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw new Error('Target client configuration file contains invalid JSON.');
      }
      if (!data || Array.isArray(data) || typeof data !== 'object' || (data.mcpServers && typeof data.mcpServers !== 'object')) {
        throw new Error('Incompatible MCP configuration structure.');
      }
      previous = data.mcpServers?.[serverName];
      installed = definition;
      if (prior && prior.path === client.path && hashValue(previous) !== prior.installedHash) {
        throw new Error('Existing MCP entry was modified outside this installer. Review it before reinstalling.');
      }
      data.mcpServers = { ...data.mcpServers, [serverName]: definition };
      next = JSON.stringify(data, null, 2) + '\n';
    }

    const record = {
      serverName,
      path: client.path,
      format: client.format,
      installedHash: hashValue(installed),
      previous: prior && prior.path === client.path ? prior.previous : previous,
      backup: text,
      installedAt: new Date().toISOString()
    };

    this.stateStore.set({ ...saved, [client.id]: record });
    try {
      atomicWrite(client.path, next);
    } catch (error) {
      this.stateStore.set(saved);
      throw error;
    }

    return { installed: true, clientId: client.id, path: client.path, restartRequired: true };
  }

  async remove(input) {
    const saved = this.stateStore.get() || {};
    const record = saved[input.clientId];
    if (!record) {
      throw new Error(`No tracked installation found for client: ${input.clientId}`);
    }

    const serverName = record.serverName || this.serverName;
    const text = readConfigSafe(record.path);
    let next;

    if (record.format === 'toml') {
      const current = getTomlSection(text, serverName);
      if (hashValue(current) !== record.installedHash) {
        throw new Error('MCP entry was modified manually; removal aborted to preserve user edits.');
      }
      next = replaceTomlSection(text, serverName, record.previous || '');
    } else {
      const data = JSON.parse(text);
      if (hashValue(data.mcpServers?.[serverName]) !== record.installedHash) {
        throw new Error('MCP entry was modified manually; removal aborted to preserve user edits.');
      }
      if (record.previous === undefined) {
        delete data.mcpServers[serverName];
      } else {
        data.mcpServers[serverName] = record.previous;
      }
      next = JSON.stringify(data, null, 2) + '\n';
    }

    atomicWrite(record.path, next);
    const remaining = { ...saved };
    delete remaining[input.clientId];
    this.stateStore.set(remaining);

    return { removed: true, clientId: input.clientId, path: record.path, restartRequired: true };
  }
}

module.exports = {
  ClientInstaller,
  knownClients,
  hashValue,
  atomicWrite,
  readConfigSafe,
  tomlSections,
  getTomlSection,
  replaceTomlSection
};
