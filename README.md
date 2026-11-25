# mcp-client-installer

[![CI](https://github.com/deusbr/mcp-client-installer/actions/workflows/ci.yml/badge.svg)](https://github.com/deusbr/mcp-client-installer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18.0.0-339933?logo=node.js&logoColor=white)](package.json)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)

Zero-dependency, **SHA-256 drift-safe** atomic configuration installer and rollback utility for **Model Context Protocol (MCP)** servers.

Extracted from [`deusbr/lume`](https://github.com/deusbr/lume) ([`lib/connectors/client-install.cjs`](https://github.com/deusbr/lume/blob/main/lib/connectors/client-install.cjs)), this library lets MCP server authors safely register or uninstall their `stdio` MCP servers in **Claude Desktop**, **Claude Code**, **Cursor**, **Codex**, and custom JSON MCP clients without corrupting configuration files or overwriting manual user edits.

## Why?

Many MCP setup scripts overwrite `claude_desktop_config.json` or `~/.claude.json` blindly, breaking formatting, dropping unrelated servers, or clobbering manual user flags. `mcp-client-installer` prevents that by:

1. **Atomic Writes:** Writes to a temporary sibling file (`0600`) and renames atomically, preventing partial/corrupted JSON or TOML files.
2. **SHA-256 Drift Detection:** Hashes the installed entry and refuses to overwrite or delete it if the user manually customized it later.
3. **Reversible Backups & Rollback:** Preserves the prior entry and raw file backup in a pluggable state store (compatible with encrypted vaults such as Electron `safeStorage`).
4. **Symlink & Size Safety:** Rejects symlinks and malformed or oversized (> 2 MB) config files before parsing.
5. **Zero Dependencies:** Uses only built-in Node.js modules (`node:fs`, `node:path`, `node:os`, `node:crypto`).

## Supported Clients

| Client ID | Client | Format | Default Path |
| :--- | :--- | :--- | :--- |
| `claude-desktop` | **Claude Desktop** | JSON (`mcpServers`) | Windows: `%APPDATA%\\Claude\\claude_desktop_config.json`<br>macOS: `~/Library/Application Support/Claude/claude_desktop_config.json` |
| `claude-code` | **Claude Code** | JSON (`mcpServers`) | `~/.claude.json` |
| `cursor` | **Cursor** | JSON (`mcpServers`) | `~/.cursor/mcp.json` |
| `codex` | **Codex** | TOML (`[mcp_servers.*]`) | `$CODEX_HOME/config.toml` or `~/.codex/config.toml` |
| `custom` | **Custom JSON Client** | JSON (`mcpServers`) | Explicit `configFile` argument |

## Usage

```javascript
const { ClientInstaller } = require('./index.cjs');

const installer = new ClientInstaller({
  serverName: 'my-mcp-server',
  definition: {
    command: 'node',
    args: ['/abs/path/to/mcp-server.js'],
    env: { MY_DATA_DIR: '/path/to/data' }
  }
});

// Check client config files on disk
console.log(installer.status());

// Install into Claude Code (~/.claude.json) atomically
await installer.install({ clientId: 'claude-code' });

// Install into Claude Desktop (claude_desktop_config.json)
await installer.install({ clientId: 'claude-desktop' });

// Safely uninstall only if entry matches recorded SHA-256 hash
await installer.remove({ clientId: 'claude-code' });
```

## Origin & Ecosystem

Originally engineered for [**Lume Desktop**](https://github.com/deusbr/lume) — an open-source MIT Windows AI desktop assistant featuring native MCP server/client support, local `llama.cpp` (CPU/Vulkan GGUF) inference, and CPU Whisper transcription.

## License

MIT License — see [`LICENSE`](LICENSE).
