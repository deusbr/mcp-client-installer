export type ClientFormat = 'json' | 'toml';

export type KnownClientId =
  | 'claude-desktop'
  | 'claude-code'
  | 'cursor'
  | 'codex'
  | 'custom';

export interface McpServerDefinition {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpClientDescriptor {
  id: KnownClientId | string;
  name: string;
  format: ClientFormat;
  path?: string;
  requiresFile?: boolean;
}

export interface StateRecord {
  serverName: string;
  path: string;
  format: ClientFormat;
  installedHash: string;
  previous?: unknown;
  backup?: string;
  installedAt: string;
}

export interface StateStore {
  get: () => Record<string, StateRecord>;
  set: (next: Record<string, StateRecord>) => void;
}

export interface ClientInstallerOptions {
  serverName: string;
  definition: McpServerDefinition;
  stateStore?: StateStore;
  clients?: McpClientDescriptor[];
}

export interface ClientStatus {
  id: string;
  name: string;
  path: string;
  requiresFile: boolean;
  exists: boolean;
  installed: boolean;
  installedPath: string;
}

export interface InstallInput {
  clientId: KnownClientId | string;
  configFile?: string;
  serverName?: string;
  definition?: McpServerDefinition;
}

export interface InstallResult {
  installed: true;
  clientId: string;
  path: string;
  restartRequired: true;
}

export interface RemoveInput {
  clientId: KnownClientId | string;
}

export interface RemoveResult {
  removed: true;
  clientId: string;
  path: string;
  restartRequired: true;
}

export class ClientInstaller {
  serverName: string;
  definition: McpServerDefinition;
  stateStore: StateStore;
  clients: McpClientDescriptor[];

  constructor(options: ClientInstallerOptions);
  status(): ClientStatus[];
  locate(input: { clientId: string; configFile?: string }): McpClientDescriptor & { path: string };
  install(input: InstallInput): Promise<InstallResult>;
  remove(input: RemoveInput): Promise<RemoveResult>;
}

export function knownClients(
  home?: string,
  appdata?: string,
  platform?: NodeJS.Platform
): McpClientDescriptor[];

export function hashValue(value: unknown): string;
export function atomicWrite(filename: string, content: string): void;
export function readConfigSafe(filename: string): string;
export function tomlSections(text: string, serverName: string): Array<[number, number]>;
export function getTomlSection(text: string, serverName: string): string;
export function replaceTomlSection(text: string, serverName: string, entry?: string): string;
