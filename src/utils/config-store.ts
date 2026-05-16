import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GlobalConfig, ServerConfig } from '../core/types';

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;

function getConfigDir(): string {
  return process.env.DEPLOY_SETUP_CONFIG_DIR || path.join(os.homedir(), '.deploy-setup');
}

function getConfigFile(): string {
  return path.join(getConfigDir(), 'config.json');
}

function ensureDir(): void {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  }
  fs.chmodSync(dir, PRIVATE_DIR_MODE);
}

export function loadGlobalConfig(): GlobalConfig {
  ensureDir();
  const configFile = getConfigFile();
  if (!fs.existsSync(configFile)) {
    return { servers: {}, projects: {} };
  }
  return JSON.parse(fs.readFileSync(configFile, "utf-8"));
}

export function saveGlobalConfig(config: GlobalConfig): void {
  ensureDir();
  fs.writeFileSync(getConfigFile(), JSON.stringify(config, null, 2), { encoding: "utf-8", mode: PRIVATE_FILE_MODE });
  fs.chmodSync(getConfigFile(), PRIVATE_FILE_MODE);
}

export function getSavedServers(): Record<string, ServerConfig> {
  return loadGlobalConfig().servers;
}

export function saveServer(name: string, server: ServerConfig): void {
  const config = loadGlobalConfig();
  config.servers[name] = server;
  saveGlobalConfig(config);
}

export function saveProjectRecord(name: string, type: string): void {
  const config = loadGlobalConfig();
  config.projects[name] = { type: type as any, lastDeploy: new Date().toISOString() };
  saveGlobalConfig(config);
}
