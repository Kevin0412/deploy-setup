import * as fs from 'fs';
import * as path from 'path';
import { CollectedConfig } from '../core/types';

const CACHE_FILE = '.deploy-setup-cache.json';
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;

function writePrivateJson(file: string, value: unknown): void {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { encoding: 'utf-8', mode: PRIVATE_FILE_MODE });
  fs.chmodSync(file, PRIVATE_FILE_MODE);
}

export function saveCache(dir: string, config: CollectedConfig): void {
  writePrivateJson(path.join(dir, CACHE_FILE), config);
}

export function loadCache(dir: string): CollectedConfig {
  const file = path.join(dir, CACHE_FILE);
  if (!fs.existsSync(file)) {
    throw new Error(`未找到配置缓存，请先运行 deploy-setup init`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

export function loadDeployConfig(dir: string, configPath?: string): CollectedConfig {
  const candidates = configPath
    ? [path.isAbsolute(configPath) ? configPath : path.join(dir, configPath)]
    : [path.join(dir, '.deploy', 'config.json'), path.join(dir, CACHE_FILE)];

  for (const file of candidates) {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    }
  }

  throw new Error(
    configPath
      ? `未找到 deploy config: ${configPath}`
      : `未找到 .deploy/config.json 或 ${CACHE_FILE}，请先运行 deploy-setup init`
  );
}

export function saveDeployConfig(dir: string, config: CollectedConfig): void {
  const deployDir = path.join(dir, '.deploy');
  fs.mkdirSync(deployDir, { recursive: true, mode: PRIVATE_DIR_MODE });
  fs.chmodSync(deployDir, PRIVATE_DIR_MODE);
  writePrivateJson(path.join(deployDir, 'config.json'), config);
}
