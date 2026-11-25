'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  ClientInstaller,
  knownClients,
  hashValue,
  atomicWrite,
  readConfigSafe,
  tomlSections,
  getTomlSection,
  replaceTomlSection
} = require('../index.cjs');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-client-installer-test-'));
}

test('knownClients resolves platform-specific paths', () => {
  const win = knownClients('C:\\Users\\alice', 'C:\\Users\\alice\\AppData\\Roaming', 'win32');
  const mac = knownClients('/Users/alice', '/Users/alice/.config', 'darwin');

  const winDesktop = win.find((c) => c.id === 'claude-desktop');
  const macDesktop = mac.find((c) => c.id === 'claude-desktop');

  assert.ok(winDesktop.path.endsWith(path.join('Claude', 'claude_desktop_config.json')));
  assert.ok(macDesktop.path.includes(path.join('Library', 'Application Support', 'Claude')));
  assert.equal(win.find((c) => c.id === 'custom').requiresFile, true);
});

test('hashValue is deterministic and handles undefined', () => {
  assert.equal(hashValue(undefined), hashValue(null));
  assert.equal(hashValue({ a: 1, b: 2 }), hashValue({ a: 1, b: 2 }));
  assert.notEqual(hashValue({ a: 1 }), hashValue({ a: 2 }));
});

test('ClientInstaller validates required constructor fields', () => {
  assert.throws(() => new ClientInstaller({ serverName: '', definition: { command: 'node' } }), /serverName/);
  assert.throws(() => new ClientInstaller({ serverName: 'demo', definition: {} }), /definition\.command/);
});

test('JSON install preserves existing servers, detects drift, and restores prior entry on remove', async () => {
  const dir = makeTempDir();
  try {
    const configFile = path.join(dir, 'claude.json');
    fs.writeFileSync(
      configFile,
      JSON.stringify(
        {
          theme: 'dark',
          mcpServers: {
            existing: { command: 'npx', args: ['-y', 'other'] },
            demo: { command: 'node', args: ['old.js'] }
          }
        },
        null,
        2
      )
    );

    const installer = new ClientInstaller({
      serverName: 'demo',
      definition: { command: 'node', args: ['new.js'], env: { FOO: 'bar' } }
    });

    const res = await installer.install({ clientId: 'custom', configFile });
    assert.equal(res.installed, true);
    assert.equal(res.path, configFile);

    const afterInstall = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    assert.equal(afterInstall.theme, 'dark');
    assert.deepEqual(afterInstall.mcpServers.existing, { command: 'npx', args: ['-y', 'other'] });
    assert.deepEqual(afterInstall.mcpServers.demo, {
      command: 'node',
      args: ['new.js'],
      env: { FOO: 'bar' }
    });

    // Simulate manual edit -> drift must block both reinstall and remove
    afterInstall.mcpServers.demo.args.push('--custom');
    fs.writeFileSync(configFile, JSON.stringify(afterInstall, null, 2));

    await assert.rejects(() => installer.install({ clientId: 'custom', configFile }), /modified outside/);
    await assert.rejects(() => installer.remove({ clientId: 'custom' }), /modified manually/);

    // Restore unmodified entry and test clean rollback to previous definition
    afterInstall.mcpServers.demo.args.pop();
    fs.writeFileSync(configFile, JSON.stringify(afterInstall, null, 2));

    const removed = await installer.remove({ clientId: 'custom' });
    assert.equal(removed.removed, true);

    const afterRemove = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    assert.deepEqual(afterRemove.mcpServers.demo, { command: 'node', args: ['old.js'] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('JSON install & remove deletes newly added entry when no prior entry existed', async () => {
  const dir = makeTempDir();
  try {
    const configFile = path.join(dir, 'nested', 'cursor.json');
    const installer = new ClientInstaller({
      serverName: 'fresh-mcp',
      definition: { command: 'node', args: ['server.cjs'] },
      clients: [{ id: 'cursor', name: 'Cursor', format: 'json', path: configFile }]
    });

    assert.equal(installer.status()[0].exists, false);
    await installer.install({ clientId: 'cursor' });
    assert.equal(installer.status()[0].installed, true);
    assert.equal(installer.status()[0].exists, true);

    await installer.remove({ clientId: 'cursor' });
    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    assert.equal('fresh-mcp' in parsed.mcpServers, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TOML install preserves unrelated sections, detects drift, and removes cleanly', async () => {
  const dir = makeTempDir();
  try {
    const tomlFile = path.join(dir, 'config.toml');
    fs.writeFileSync(
      tomlFile,
      [
        'model = "gpt-5"',
        '',
        '[mcp_servers.other]',
        'command = "python"',
        'args = ["-m", "other"]',
        ''
      ].join('\n')
    );

    const installer = new ClientInstaller({
      serverName: 'lume-mcp',
      definition: { command: 'node', args: ['mcp.cjs'], env: { LUME_HOME: '/tmp/lume' } },
      clients: [{ id: 'codex', name: 'Codex', format: 'toml', path: tomlFile }]
    });

    await installer.install({ clientId: 'codex' });
    const text = fs.readFileSync(tomlFile, 'utf8');
    assert.match(text, /\[mcp_servers\.other\]/);
    assert.match(text, /\[mcp_servers\.lume-mcp\]/);
    assert.match(text, /\[mcp_servers\.lume-mcp\.env\]/);
    assert.equal(tomlSections(text, 'lume-mcp').length, 1);
    assert.ok(getTomlSection(text, 'lume-mcp').includes('LUME_HOME'));

    // Manual edit triggers drift protection
    atomicWrite(tomlFile, text + '# manual edit\n');
    // Comment at end of section changes raw section text hash
    await assert.rejects(() => installer.remove({ clientId: 'codex' }), /modified manually/);

    // Replace with clean section and verify removal leaves [mcp_servers.other] intact
    atomicWrite(tomlFile, text);
    await installer.remove({ clientId: 'codex' });
    const finalToml = fs.readFileSync(tomlFile, 'utf8');
    assert.match(finalToml, /\[mcp_servers\.other\]/);
    assert.equal(getTomlSection(finalToml, 'lume-mcp'), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readConfigSafe rejects oversized files and non-file targets', () => {
  const dir = makeTempDir();
  try {
    assert.equal(readConfigSafe(path.join(dir, 'missing.json')), '');
    assert.throws(() => readConfigSafe(dir), /Invalid or oversized/);

    const bigFile = path.join(dir, 'big.json');
    fs.writeFileSync(bigFile, Buffer.alloc(2 * 1024 * 1024 + 1, ' '));
    assert.throws(() => readConfigSafe(bigFile), /Invalid or oversized/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('replaceTomlSection removes quoted section names safely', () => {
  const sample = '[mcp_servers."my.server"]\ncommand = "node"\n\n[mcp_servers.keep]\ncommand = "echo"\n';
  const updated = replaceTomlSection(sample, 'my.server', '');
  assert.equal(getTomlSection(updated, 'my.server'), '');
  assert.match(updated, /\[mcp_servers\.keep\]/);
});
