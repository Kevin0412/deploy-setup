export type ProjectType =
  | 'flask'
  | 'django'
  | 'fastapi'
  | 'nestjs'
  | 'nextjs'
  | 'nuxtjs'
  | 'vue-spa'
  | 'react-spa'
  | 'proxy-service';

export type Language = 'python' | 'node';

export type DbType = 'sqlite' | 'postgres' | 'mysql' | 'none';
export type OrmTool = 'alembic' | 'django-migrations' | 'prisma' | 'typeorm' | 'none';

export type Scenario = 'simple-web' | 'monorepo-node' | 'tauri-desktop';
export type PostInitAction = 'none' | 'setup-server' | 'patch-server';

export interface ProxyRepoConfig {
  enabled: boolean;
  owner: string;
  repo: string;
  eventType: string;
  checkoutTokenSecret: string;
}

// Exit codes for structured CLI output
export const EXIT_SUCCESS = 0;
export const EXIT_CONFIG_ERROR = 1;
export const EXIT_NETWORK_ERROR = 2;
export const EXIT_SECRET_MISSING = 3;
export const EXIT_PROXY_REPO_FAILED = 4;

export interface FrameworkProfile {
  dataDir: string;
  dbInitCmd: string;
  dbMigrateCmd: string;
  ormTool: OrmTool;
  defaultPort: number;
  startCmd: string;
  buildCmd: string;
  entryFile: string;
}

export interface DetectionResult {
  type: ProjectType | null;
  language: Language | null;
  languageVersion: string;
  port: number;
  buildCmd: string;
  startCmd: string;
  entryFile: string;
  envFile: string | null;
  envKeys: string[];
  envPairs: Record<string, string>;
  hasDocker: boolean;
  hasCI: boolean;
  dataDir: string;
  dbType: DbType;
  ormTool: OrmTool;
  projectStructure: 'standard' | 'multi-dir';
  subDirs: { server?: string; client?: string };
  nativeModules: string[];
  scenario?: Scenario;
}

export interface ServerConfig {
  host: string;
  user: string;
  sshKeyPath: string;
  sshPort?: number;
  sudoMode?: 'none' | 'tty';
  deployDir: string;
}

export interface DomainConfig {
  enabled: boolean;
  name: string;
  https: boolean;
}

export interface BranchConfig {
  production: string;
  staging: string | null;
}

export interface CollectedConfig {
  project: {
    name: string;
    type: ProjectType;
    language: Language;
    port: number;
    buildCmd: string;
    startCmd: string;
    projectStructure: 'standard' | 'multi-dir';
    subDirs: { server?: string; client?: string };
  };
  server: ServerConfig;
  domain: DomainConfig;
  secrets: string[];
  envVars: Record<string, string>;
  branches: BranchConfig;
  postInitAction?: PostInitAction;
  deploymentMode?: 'generated' | 'existing-compose';
  proxyMode?: 'host-nginx' | 'existing-caddy' | 'none';

  strategy?: DeployStrategy;

  proxyRepo?: ProxyRepoConfig;
  scenario?: Scenario;
  servers?: ServerConfig[];

  database: {
    type: DbType;
    location: 'host' | 'container' | 'external' | 'none';
    dataDir: string;
    initCmd: string;
    migrateCmd: string;
    createAdmin: boolean;
    adminCmd: string;
  };
}

export interface ProbeResult {
  memoryMB: number;
  cpuCores: number;
  diskFreeGB: number;
  dockerInstalled: boolean;
  dockerComposeInstalled: boolean;
  dockerHubReachable: boolean;
  npmReachable: boolean;
  alpineReachable: boolean;
  geoCountry: string;
  githubApiReachable: boolean;
  needsChinaMirrors: boolean;
}

export interface DeployStrategy {
  buildLocation: 'ci' | 'server';
  transferMethod: 'scp' | 'registry' | 'none';
  mirrors: {
    alpine?: string;
    npm?: string;
    pip?: string;
    docker?: string[];
  };
  needsBuildTools: boolean;
  /**
   * command_timeout for the deploy step in CI workflow.
   * Calculated from probe results: 15min default, 25min when China mirrors
   * are needed (npm/alpine/docker fetches are slow through proxies) or when
   * the server is resource-constrained (<2GB RAM or <2 CPU cores, where
   * docker compose up can stall on native module compilation).
   */
  deployTimeoutMinutes: number;
}

export interface GlobalConfig {
  servers: Record<string, ServerConfig>;
  projects: Record<string, { type: ProjectType; lastDeploy?: string }>;
}

export const FRAMEWORK_PROFILES: Record<ProjectType, FrameworkProfile> = {
  flask: {
    dataDir: 'instance',
    dbInitCmd: 'flask db upgrade',
    dbMigrateCmd: 'flask db upgrade',
    ormTool: 'alembic',
    defaultPort: 5000,
    startCmd: 'gunicorn -w 4 -b 0.0.0.0:5000 app:app',
    buildCmd: '',
    entryFile: 'app.py',
  },
  django: {
    dataDir: 'media',
    dbInitCmd: 'python manage.py migrate',
    dbMigrateCmd: 'python manage.py migrate',
    ormTool: 'django-migrations',
    defaultPort: 8000,
    startCmd: 'gunicorn -w 4 -b 0.0.0.0:8000 config.wsgi:application',
    buildCmd: 'python manage.py collectstatic --noinput',
    entryFile: 'manage.py',
  },
  fastapi: {
    dataDir: 'data',
    dbInitCmd: 'alembic upgrade head',
    dbMigrateCmd: 'alembic upgrade head',
    ormTool: 'alembic',
    defaultPort: 8000,
    startCmd: 'uvicorn main:app --host 0.0.0.0 --port 8000',
    buildCmd: '',
    entryFile: 'main.py',
  },
  nestjs: {
    dataDir: 'uploads',
    dbInitCmd: 'npx prisma migrate deploy',
    dbMigrateCmd: 'npx prisma migrate deploy',
    ormTool: 'prisma',
    defaultPort: 3000,
    startCmd: 'node dist/main',
    buildCmd: 'npm run build',
    entryFile: 'src/main.ts',
  },
  nextjs: {
    dataDir: '.next',
    dbInitCmd: 'npx prisma migrate deploy',
    dbMigrateCmd: 'npx prisma migrate deploy',
    ormTool: 'prisma',
    defaultPort: 3000,
    startCmd: 'npm start',
    buildCmd: 'npm run build',
    entryFile: 'pages/index.tsx',
  },
  nuxtjs: {
    dataDir: '.output',
    dbInitCmd: 'npx prisma migrate deploy',
    dbMigrateCmd: 'npx prisma migrate deploy',
    ormTool: 'prisma',
    defaultPort: 3000,
    startCmd: 'node .output/server/index.mjs',
    buildCmd: 'npm run build',
    entryFile: 'nuxt.config.ts',
  },
  'vue-spa': {
    dataDir: '',
    dbInitCmd: '',
    dbMigrateCmd: '',
    ormTool: 'none',
    defaultPort: 8080,
    startCmd: '',
    buildCmd: 'npm run build',
    entryFile: 'src/main.ts',
  },
  'react-spa': {
    dataDir: '',
    dbInitCmd: '',
    dbMigrateCmd: '',
    ormTool: 'none',
    defaultPort: 8080,
    startCmd: '',
    buildCmd: 'npm run build',
    entryFile: 'src/index.tsx',
  },
  'proxy-service': {
    dataDir: '',
    dbInitCmd: '',
    dbMigrateCmd: '',
    ormTool: 'none',
    defaultPort: 8080,
    startCmd: '',
    buildCmd: '',
    entryFile: '',
  },
};

// Backward compatibility alias
export const PROJECT_DEFAULTS = Object.fromEntries(
  Object.entries(FRAMEWORK_PROFILES).map(([k, v]) => [k, {
    port: v.defaultPort,
    buildCmd: v.buildCmd,
    startCmd: v.startCmd,
    entryFile: v.entryFile,
  }])
) as Record<ProjectType, { port: number; buildCmd: string; startCmd: string; entryFile: string }>;
