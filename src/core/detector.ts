import * as fs from 'fs';
import * as path from 'path';
import { DetectionResult, ProjectType, Language, FRAMEWORK_PROFILES, OrmTool, DbType, Scenario } from './types';

const KNOWN_NATIVE_MODULES = [
  'better-sqlite3', 'sqlite3', 'bcrypt', 'sharp', 'canvas',
  'node-sass', 'pg-native', 'cpu-features', 'argon2', 'sodium-native',
  're2', 'deasync', 'microtime', 'node-pty', 'leveldown',
  'grpc', '@grpc/grpc-js', 'node-hid', 'usb', 'serialport',
];
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function detectProject(rootDir: string): DetectionResult {
  const files = fs.readdirSync(rootDir);
  const result: DetectionResult = {
    type: null,
    language: null,
    languageVersion: '',
    port: 3000,
    buildCmd: '',
    startCmd: '',
    entryFile: '',
    envFile: null,
    envKeys: [],
    envPairs: {},
    hasDocker: files.includes('Dockerfile'),
    hasCI: fs.existsSync(path.join(rootDir, '.github', 'workflows')),
    dataDir: '',
    dbType: 'none',
    ormTool: 'none',
    projectStructure: 'standard',
    subDirs: {},
    nativeModules: [],
  };

  // Detect multi-directory structure FIRST (needed for .env search)
  const dirPairs = [
    { server: 'server', client: 'client' },
    { server: 'backend', client: 'frontend' },
  ];
  for (const pair of dirPairs) {
    const serverPkg = path.join(rootDir, pair.server, 'package.json');
    const clientPkg = path.join(rootDir, pair.client, 'package.json');
    if (fs.existsSync(serverPkg) && fs.existsSync(clientPkg)) {
      result.projectStructure = 'multi-dir';
      result.subDirs = { server: pair.server, client: pair.client };
      break;
    }
  }

  // Detect .env (searches root dir, then server subdir for multi-dir projects)
  const envRelPath = findEnvFile(rootDir, result.subDirs);
  if (envRelPath) {
    result.envFile = envRelPath;
    const parsed = parseEnvPairs(path.join(rootDir, envRelPath));
    result.envKeys = parsed.keys;
    result.envPairs = parsed.pairs;
  }

  // Python project detection
  if (files.includes('requirements.txt') || files.includes('pyproject.toml') || files.includes('Pipfile')) {
    result.language = 'python';
    result.languageVersion = '3.11';
    result.type = detectPythonFramework(rootDir, files);
  }
  // Node project detection
  else if (files.includes('package.json')) {
    result.language = 'node';
    result.languageVersion = '20';
    result.type = detectNodeFramework(rootDir);
  }

  // Apply framework defaults
  if (result.type) {
    const profile = FRAMEWORK_PROFILES[result.type];
    result.port = profile.defaultPort;
    result.buildCmd = profile.buildCmd;
    result.startCmd = profile.startCmd;
    result.entryFile = profile.entryFile;
    result.dataDir = profile.dataDir;
    result.ormTool = profile.ormTool;
  }

  // Detect ORM tool (may override framework default)
  const detectedOrm = detectOrmTool(rootDir, files, result.language);
  if (detectedOrm !== 'none') {
    result.ormTool = detectedOrm;
  }

  // Detect native modules
  result.nativeModules = detectNativeModules(rootDir, result.language, result.projectStructure, result.subDirs);

  // Detect deployment scenario
  result.scenario = detectScenario(rootDir);

  // Detect database type from .env
  if (result.envFile) {
    result.dbType = detectDbType(path.join(rootDir, result.envFile));
  }

  return result;
}

function findEnvFile(rootDir: string, subDirs: { server?: string; client?: string }): string | null {
  const envNames = ['.env', '.env.example', '.env.production'];

  // Priority 1: root directory
  for (const name of envNames) {
    if (fs.existsSync(path.join(rootDir, name))) {
      return name;
    }
  }

  // Priority 2: server subdir (for multi-dir projects)
  if (subDirs.server) {
    for (const name of envNames) {
      const relPath = path.join(subDirs.server, name);
      if (fs.existsSync(path.join(rootDir, relPath))) {
        return relPath;
      }
    }
  }

  return null;
}

function detectPythonFramework(rootDir: string, files: string[]): ProjectType | null {
  const reqPath = path.join(rootDir, 'requirements.txt');
  let deps = '';
  if (fs.existsSync(reqPath)) {
    deps = fs.readFileSync(reqPath, 'utf-8').toLowerCase();
  }

  if (deps.includes('django') || files.includes('manage.py')) return 'django';
  if (deps.includes('fastapi')) return 'fastapi';
  if (deps.includes('flask')) return 'flask';
  return null;
}

function detectNodeFramework(rootDir: string): ProjectType | null {
  const pkgPath = path.join(rootDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

  if (allDeps['@nestjs/core']) return 'nestjs';
  if (allDeps['next']) return 'nextjs';
  if (allDeps['nuxt'] || allDeps['nuxt3']) return 'nuxtjs';
  if (allDeps['vue']) return 'vue-spa';
  if (allDeps['react']) return 'react-spa';
  return null;
}

function detectOrmTool(rootDir: string, files: string[], language: Language | null): OrmTool {
  if (language === 'python') {
    const reqPath = path.join(rootDir, 'requirements.txt');
    if (fs.existsSync(reqPath)) {
      const deps = fs.readFileSync(reqPath, 'utf-8').toLowerCase();
      if (deps.includes('flask-migrate') || deps.includes('alembic')) return 'alembic';
      if (deps.includes('django')) return 'django-migrations';
    }
  } else if (language === 'node') {
    const pkgPath = path.join(rootDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (allDeps['prisma'] || allDeps['@prisma/client']) return 'prisma';
      if (allDeps['typeorm']) return 'typeorm';
    }
  }
  return 'none';
}

function detectDbType(envFilePath: string): DbType {
  const content = fs.readFileSync(envFilePath, 'utf-8');
  const match = content.match(/DATABASE_URL\s*=\s*(.+)/);
  if (!match) return 'none';

  const url = match[1].trim();
  if (url.startsWith('sqlite')) return 'sqlite';
  if (url.startsWith('postgres')) return 'postgres';
  if (url.startsWith('mysql')) return 'mysql';
  return 'none';
}

function parseEnvPairs(envFilePath: string): { keys: string[]; pairs: Record<string, string> } {
  const content = fs.readFileSync(envFilePath, 'utf-8');
  const keys: string[] = [];
  const pairs: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!ENV_KEY_RE.test(key)) continue;
    const value = trimmed.slice(eqIdx + 1).trim();
    keys.push(key);
    pairs[key] = value;
  }
  return { keys, pairs };
}

/**
 * Detect the deployment scenario based on project file structure.
 * - tauri-desktop: has src-tauri/Cargo.toml + tauri.conf.json
 * - monorepo-node: has pnpm-workspace.yaml + apps/server + apps/admin (or apps/ with multiple packages)
 * - simple-web: fallback
 */
export function detectScenario(rootDir: string): Scenario {
  // Check for Tauri project
  const hasTauriCargo = fs.existsSync(path.join(rootDir, 'src-tauri', 'Cargo.toml'));
  const hasTauriConf = fs.existsSync(path.join(rootDir, 'src-tauri', 'tauri.conf.json'));
  // Also check nested: apps/desktop/src-tauri (common monorepo layout)
  const hasNestedTauriCargo = fs.existsSync(path.join(rootDir, 'apps', 'desktop', 'src-tauri', 'Cargo.toml'));
  const hasNestedTauriConf = fs.existsSync(path.join(rootDir, 'apps', 'desktop', 'src-tauri', 'tauri.conf.json'));

  if ((hasTauriCargo && hasTauriConf) || (hasNestedTauriCargo && hasNestedTauriConf)) {
    return 'tauri-desktop';
  }

  // Check for monorepo-node
  const hasPnpmWorkspace = fs.existsSync(path.join(rootDir, 'pnpm-workspace.yaml'));
  const hasAppsServer = fs.existsSync(path.join(rootDir, 'apps', 'server'));
  const hasAppsAdmin = fs.existsSync(path.join(rootDir, 'apps', 'admin'));

  if (hasPnpmWorkspace && hasAppsServer && hasAppsAdmin) {
    return 'monorepo-node';
  }

  return 'simple-web';
}

function detectNativeModules(
  rootDir: string,
  language: Language | null,
  structure: string,
  subDirs: { server?: string; client?: string }
): string[] {
  if (language !== 'node') return [];

  const found = new Set<string>();
  const pkgPaths: string[] = [path.join(rootDir, 'package.json')];

  // For monorepo, also check workspace package.json files
  if (structure === 'multi-dir') {
    if (subDirs.server) pkgPaths.push(path.join(rootDir, subDirs.server, 'package.json'));
    if (subDirs.client) pkgPaths.push(path.join(rootDir, subDirs.client, 'package.json'));
  }

  for (const pkgPath of pkgPaths) {
    if (!fs.existsSync(pkgPath)) continue;
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      for (const dep of Object.keys(allDeps)) {
        if (KNOWN_NATIVE_MODULES.includes(dep)) {
          found.add(dep);
        }
      }
    } catch { /* ignore parse errors */ }
  }

  return Array.from(found);
}
