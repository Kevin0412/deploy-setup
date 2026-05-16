import * as fs from 'fs';
import * as path from 'path';
import { CollectedConfig } from '../core/types';

const CACHE_FILE = '.deploy-setup-cache.json';

export function saveCache(dir: string, config: CollectedConfig): void {
  fs.writeFileSync(path.join(dir, CACHE_FILE), JSON.stringify(config, null, 2), 'utf-8');
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
  fs.mkdirSync(deployDir, { recursive: true });
  fs.writeFileSync(path.join(deployDir, 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
}
