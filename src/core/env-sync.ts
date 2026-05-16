import { CollectedConfig } from './types';

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertEnvKey(key: string): string {
  if (!ENV_KEY_RE.test(key)) {
    throw new Error(`环境变量名不安全: ${key}。仅支持字母、数字和下划线，且不能以数字开头。`);
  }
  return key;
}

function normalizeEnvValue(value: unknown): string {
  return String(value ?? '').replace(/\r?\n/g, '\\n');
}

export interface EnvDiff {
  added: string[];
  removed: string[];
  unchanged: string[];
}

export function diffEnvKeys(currentKeys: string[], cachedConfig: CollectedConfig): EnvDiff {
  const cachedAllKeys = new Set([
    ...Object.keys(cachedConfig.envVars || {}),
    ...(cachedConfig.secrets || []),
  ]);

  const currentSet = new Set(currentKeys);

  const added: string[] = [];
  const removed: string[] = [];
  const unchanged: string[] = [];

  for (const key of currentKeys) {
    if (cachedAllKeys.has(key)) {
      unchanged.push(key);
    } else {
      added.push(key);
    }
  }

  for (const key of cachedAllKeys) {
    if (!currentSet.has(key)) {
      removed.push(key);
    }
  }

  return { added, removed, unchanged };
}

export function buildEnvBlock(envVars: Record<string, string>, secrets: string[]): string {
  const indent = '            ';
  const lines: string[] = [];

  // heredoc block for hardcoded vars
  lines.push(`${indent}cat > .env << 'ENVEOF'`);
  for (const [key, value] of Object.entries(envVars)) {
    lines.push(`${indent}${assertEnvKey(key)}=${normalizeEnvValue(value)}`);
  }
  for (const key of secrets) {
    const safeKey = assertEnvKey(key);
    lines.push(`${indent}${safeKey}=\${{ secrets.${safeKey} }}`);
  }
  lines.push(`${indent}ENVEOF`);
  lines.push(`${indent}sed -i 's/^ *//' .env`);

  return lines.join('\n');
}

export function patchDeployYml(content: string, envVars: Record<string, string>, secrets: string[]): string {
  const startMarker = '# Generate complete .env';
  const endMarker = 'docker compose pull';

  const startIdx = content.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error(`deploy.yml 中未找到标记: "${startMarker}"\n请确保 workflow 文件包含此注释行`);
  }

  const endIdx = content.indexOf(endMarker, startIdx);
  if (endIdx === -1) {
    throw new Error(`deploy.yml 中未找到标记: "${endMarker}"\n请确保 workflow 文件包含 docker compose pull 行`);
  }

  const indent = '            ';
  const newBlock = `${startMarker}\n${buildEnvBlock(envVars, secrets)}\n\n${indent}`;

  return content.slice(0, startIdx) + newBlock + content.slice(endIdx);
}
