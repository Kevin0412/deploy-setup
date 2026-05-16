import inquirer from 'inquirer';
import chalk from 'chalk';
import { DetectionResult, ProjectType, CollectedConfig, Language, ServerConfig, FRAMEWORK_PROFILES, PostInitAction } from './types';
import { getSavedServers, saveServer } from '../utils/config-store';
import { execSync } from 'child_process';
import * as fs from 'fs';
import { buildSshCommand, normalizeSshPort, resolveSshKeyPath } from '../utils/ssh-runner';

const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
  flask: 'Flask',
  django: 'Django',
  fastapi: 'FastAPI',
  nestjs: 'NestJS',
  nextjs: 'Next.js',
  nuxtjs: 'Nuxt.js',
  'vue-spa': 'Vue SPA',
  'react-spa': 'React SPA',
  'proxy-service': 'Proxy Service',
};

async function scanRemotePorts(server: ServerConfig): Promise<number[]> {
  try {
    console.log(chalk.gray('  扫描服务器端口占用...'));
    const sshCmd = buildSshCommand(
      server,
      `ss -tlnp | awk '{print $4}' | grep -oP ':\\K[0-9]+$' | sort -un`,
      { connectTimeout: 10 },
    );
    const result = execSync(
      sshCmd,
      { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const ports = result.trim().split('\n').filter(Boolean).map(Number).filter(n => !isNaN(n));
    console.log(chalk.green(`  ✔ 已扫描，${ports.length} 个端口被占用`));
    return ports;
  } catch (err: any) {
    console.log(chalk.yellow(`  ⚠ 端口扫描失败 (${err.message?.slice(0, 50)}), 将跳过预检`));
    return [];
  }
}

function findAvailablePort(defaultPort: number, occupiedPorts: Set<number>): number {
  let port = defaultPort;
  while (occupiedPorts.has(port)) {
    port++;
  }
  return port;
}

const COMMON_SSH_KEYS = [
  '~/.ssh/id_ed25519',
  '~/.ssh/id_rsa',
  '~/.ssh/id_ecdsa',
  '~/.ssh/id_ed25519_sk',
  '~/.ssh/id_ecdsa_sk',
];

function buildSshKeyChoices() {
  const defaultKey = COMMON_SSH_KEYS.find(key => fs.existsSync(resolveSshKeyPath(key))) || '~/.ssh/id_ed25519';
  return {
    defaultKey,
    choices: [
      ...COMMON_SSH_KEYS.map(key => ({
        name: fs.existsSync(resolveSshKeyPath(key)) ? `${key} (存在)` : key,
        value: key,
      })),
      { name: '手动输入其他私钥路径...', value: '__manual__' },
    ],
  };
}

async function promptSshKeyPath(defaultKey?: string): Promise<string> {
  const { choices, defaultKey: detectedDefaultKey } = buildSshKeyChoices();
  const defaultChoice = defaultKey && !COMMON_SSH_KEYS.includes(defaultKey)
    ? '__manual__'
    : (defaultKey || detectedDefaultKey);
  const { sshKeyChoice } = await inquirer.prompt([{
    type: 'list',
    name: 'sshKeyChoice',
    message: 'SSH 私钥路径:',
    choices,
    default: defaultChoice,
  }]);

  if (sshKeyChoice !== '__manual__') {
    return sshKeyChoice;
  }

  const { sshKeyPath } = await inquirer.prompt([{
    type: 'input',
    name: 'sshKeyPath',
    message: '输入 SSH 私钥路径:',
    default: defaultKey || detectedDefaultKey,
    validate: (v: string) => v.trim().length > 0 || '不能为空',
  }]);
  return sshKeyPath;
}

async function promptSudoMode(user: string, defaultMode?: 'none' | 'tty'): Promise<'none' | 'tty'> {
  if (user === 'root') {
    return 'none';
  }

  const { sudoMode } = await inquirer.prompt([{
    type: 'list',
    name: 'sudoMode',
    message: '需要 sudo 时如何处理?',
    choices: [
      {
        name: '通过 SSH 远程终端输入 sudo 密码（不保存密码）',
        value: 'tty',
      },
      {
        name: '不使用交互 sudo（已配置免密 sudo / 无需 sudo）',
        value: 'none',
      },
    ],
    default: defaultMode || 'tty',
  }]);

  return sudoMode;
}

async function promptPostInitActionChoice(defaultAction: PostInitAction = 'none'): Promise<PostInitAction> {
  const { postInitAction } = await inquirer.prompt([{
    type: 'list',
    name: 'postInitAction',
    message: '服务器配置完成后执行什么?',
    choices: [
      { name: '暂不执行，只生成配置文件', value: 'none' },
      { name: '初始化服务器 / 部署前准备（需要部署目录）', value: 'setup-server' },
      { name: '已部署服务器：只打安全补丁（跳过部署目录）', value: 'patch-server' },
    ],
    default: defaultAction,
  }]);

  return postInitAction;
}

export async function collectConfig(detection: DetectionResult, projectName: string): Promise<CollectedConfig> {
  console.log(chalk.cyan('\n📋 开始收集部署配置...\n'));

  // 先收集服务器信息，以便扫描端口
  const { server, postInitAction } = await collectServerConfig();

  if (postInitAction === 'patch-server') {
    return await reviewLoop(createPatchOnlyConfig(server, projectName, detection), detection);
  }

  // SSH 扫描服务器已占端口
  const occupiedPorts = await scanRemotePorts(server);
  const occupiedSet = new Set(occupiedPorts);

  const project = await collectProjectConfig(detection, projectName, occupiedSet);
  const domain = await collectDomainConfig();
  const secrets = await collectSecrets(detection.envKeys);
  const branches = await collectBranchConfig();

  const database = await collectDatabaseConfig(detection);

  // Non-secret env vars get their values preserved for hardcoded .env generation
  const secretSet = new Set(secrets);
  const envVars: Record<string, string> = {};
  for (const [key, value] of Object.entries(detection.envPairs)) {
    if (!secretSet.has(key)) {
      envVars[key] = value;
    }
  }

  // Extract deploymentMode and proxyMode from project if present
  const { deploymentMode, proxyMode, ...projectBase } = project as any;

  const config: CollectedConfig = {
    project: projectBase,
    server,
    domain,
    secrets,
    envVars,
    branches,
    postInitAction,
    deploymentMode,
    proxyMode,
    database,
  };

  return await reviewLoop(config, detection);
}

function createPatchOnlyConfig(
  server: ServerConfig,
  projectName: string,
  detection: DetectionResult,
): CollectedConfig {
  return {
    project: {
      name: projectName,
      type: 'proxy-service',
      language: detection.language || 'node',
      port: detection.port || 0,
      buildCmd: '',
      startCmd: '',
      projectStructure: detection.projectStructure || 'standard',
      subDirs: detection.subDirs || {},
    },
    server,
    domain: {
      enabled: false,
      name: '',
      https: false,
    },
    secrets: [],
    envVars: {},
    branches: {
      production: 'main',
      staging: null,
    },
    postInitAction: 'patch-server',
    deploymentMode: 'generated',
    proxyMode: 'none',
    database: {
      type: 'none',
      location: 'none',
      dataDir: '',
      initCmd: '',
      migrateCmd: '',
      createAdmin: false,
      adminCmd: '',
    },
  };
}

async function collectProjectConfig(detection: DetectionResult, projectName: string, occupiedPorts: Set<number> = new Set()) {
  const typeChoices = Object.entries(PROJECT_TYPE_LABELS).map(([value, name]) => ({ name, value }));

  // 先问项目类型，以便确定默认端口
  const typeAnswer = await inquirer.prompt([
    {
      type: 'input',
      name: 'name',
      message: '项目名称:',
      default: projectName,
      validate: (v: string) => /^[a-z0-9-]+$/.test(v) || '只允许小写字母、数字和连字符',
    },
    {
      type: 'list',
      name: 'type',
      message: '项目类型:',
      choices: typeChoices,
      default: detection.type,
    },
  ]);

  // 根据项目类型确定默认端口，并自动避开已占端口
  const selectedType = typeAnswer.type as ProjectType;
  const profile = FRAMEWORK_PROFILES[selectedType];
  const rawDefault = detection.port || profile?.defaultPort || 3000;
  const suggestedPort = findAvailablePort(rawDefault, occupiedPorts);

  // 显示已占端口提示
  if (occupiedPorts.size > 0) {
    const appPorts = Array.from(occupiedPorts).filter(p => p >= 3000 && p <= 65535).sort((a, b) => a - b);
    if (appPorts.length > 0) {
      console.log(chalk.yellow(`  已占用的应用端口: ${appPorts.join(', ')}`));
    }
    if (suggestedPort !== rawDefault) {
      console.log(chalk.yellow(`  默认端口 ${rawDefault} 已被占用，建议使用 ${suggestedPort}`));
    }
  }

  const portAnswer = await inquirer.prompt([
    {
      type: 'number',
      name: 'port',
      message: '应用端口:',
      default: suggestedPort,
      validate: (v: number) => {
        if (occupiedPorts.has(v)) {
          return `端口 ${v} 已被服务器占用，请选择其他端口`;
        }
        return true;
      },
    },
    {
      type: 'input',
      name: 'buildCmd',
      message: '构建命令 (留空则无):',
      default: detection.buildCmd,
    },
    {
      type: 'input',
      name: 'startCmd',
      message: '启动命令:',
      default: detection.startCmd,
    },
  ]);

  const type = selectedType;
  const language: Language = ['flask', 'django', 'fastapi'].includes(type) ? 'python' : 'node';

  // Proxy service specific options
  let deploymentMode: 'generated' | 'existing-compose' = 'generated';
  let proxyMode: 'host-nginx' | 'existing-caddy' | 'none' = 'host-nginx';

  if (type === 'proxy-service') {
    const deploymentAnswer = await inquirer.prompt([
      {
        type: 'list',
        name: 'deploymentMode',
        message: '部署模式:',
        choices: [
          { name: '生成 Docker Compose 配置', value: 'generated' },
          { name: '使用现有 docker-compose.yml', value: 'existing-compose' },
        ],
        default: 'generated',
      },
    ]);
    deploymentMode = deploymentAnswer.deploymentMode;

    const proxyAnswer = await inquirer.prompt([
      {
        type: 'list',
        name: 'proxyMode',
        message: '反向代理模式:',
        choices: [
          { name: '宿主机 Nginx (自动配置)', value: 'host-nginx' },
          { name: '现有 Caddy (跳过 Nginx 配置)', value: 'existing-caddy' },
          { name: '无反向代理', value: 'none' },
        ],
        default: 'host-nginx',
      },
    ]);
    proxyMode = proxyAnswer.proxyMode;
  }

  return {
    ...typeAnswer,
    ...portAnswer,
    language,
    projectStructure: detection.projectStructure || 'standard',
    subDirs: detection.subDirs || {},
    deploymentMode,
    proxyMode,
  };
}

async function collectServerConfig(): Promise<{ server: ServerConfig; postInitAction: PostInitAction }> {
  const saved = getSavedServers();
  const serverNames = Object.keys(saved);

  let server: ServerConfig;

  if (serverNames.length > 0) {
    const { choice } = await inquirer.prompt([{
      type: 'list',
      name: 'choice',
      message: '选择服务器:',
      choices: [
        ...serverNames.map(name => ({
          name: `${name} (${saved[name].host}:${saved[name].sshPort || 22})`,
          value: name,
        })),
        { name: '+ 添加新服务器', value: '__new__' },
      ],
    }]);

    if (choice !== '__new__') {
      server = { ...saved[choice] };
      const { sshPort } = await inquirer.prompt([{
        type: 'number',
        name: 'sshPort',
        message: 'SSH 端口:',
        default: server.sshPort || 22,
        validate: (v: number) => {
          try {
            normalizeSshPort(v);
            return true;
          } catch (err: any) {
            return err.message;
          }
        },
      }]);
      server.sshPort = normalizeSshPort(sshPort);
      server.sshKeyPath = await promptSshKeyPath(server.sshKeyPath);
      server.sudoMode = await promptSudoMode(server.user, server.sudoMode);
      const postInitAction = await promptPostInitActionChoice();
      if (postInitAction !== 'setup-server') {
        server.deployDir = server.deployDir || '/opt/apps';
      } else {
        const { deployDir } = await inquirer.prompt([{
          type: 'input',
          name: 'deployDir',
          message: '部署目录:',
          default: server.deployDir,
        }]);
        server.deployDir = deployDir;
      }
      return { server, postInitAction };
    }
  }

  const identity = await inquirer.prompt([
    {
      type: 'input',
      name: 'host',
      message: '服务器 IP/域名:',
      validate: (v: string) => v.trim().length > 0 || '不能为空',
    },
    {
      type: 'input',
      name: 'user',
      message: 'SSH 用户名:',
      default: 'root',
    },
    {
      type: 'number',
      name: 'sshPort',
      message: 'SSH 端口:',
      default: 22,
      validate: (v: number) => {
        try {
          normalizeSshPort(v);
          return true;
        } catch (err: any) {
          return err.message;
        }
      },
    },
  ]);

  const sshKeyPath = await promptSshKeyPath();
  const sudoMode = await promptSudoMode(identity.user);
  const postInitAction = await promptPostInitActionChoice();

  const rest = postInitAction !== 'setup-server'
    ? { deployDir: '/opt/apps' }
    : await inquirer.prompt([
      {
        type: 'input',
        name: 'deployDir',
        message: '部署目录:',
        default: '/opt/apps',
      },
    ]);

  const answers: ServerConfig = {
    ...identity,
    sshPort: normalizeSshPort(identity.sshPort),
    sshKeyPath,
    sudoMode,
    ...rest,
  };

  // Save for future use
  const { saveName } = await inquirer.prompt([{
    type: 'input',
    name: 'saveName',
    message: '为此服务器取个名字 (方便下次选择):',
    default: answers.host,
  }]);
  saveServer(saveName, answers);

  return { server: answers, postInitAction };
}

async function collectDomainConfig() {
  const { enabled } = await inquirer.prompt([{
    type: 'confirm',
    name: 'enabled',
    message: '是否配置域名?',
    default: false,
  }]);

  if (!enabled) {
    return { enabled: false, name: '', https: false };
  }

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'name',
      message: '域名:',
      validate: (v: string) => v.trim().length > 0 || '不能为空',
    },
    {
      type: 'confirm',
      name: 'https',
      message: '启用 HTTPS (Let\'s Encrypt)?',
      default: true,
    },
  ]);

  return { enabled, ...answers };
}

async function collectSecrets(envKeys: string[]): Promise<string[]> {
  if (envKeys.length === 0) {
    console.log(chalk.yellow('  未检测到 .env 文件，跳过环境变量配置'));
    return [];
  }

  console.log(chalk.cyan('\n  检测到以下环境变量:'));
  envKeys.forEach(k => console.log(`    ${k}`));

  const { secrets } = await inquirer.prompt([{
    type: 'checkbox',
    name: 'secrets',
    message: '选择需要作为 GitHub Secrets 的敏感变量:',
    choices: envKeys.map(k => ({
      name: k,
      value: k,
      checked: /secret|password|key|token|api/i.test(k),
    })),
  }]);

  return secrets;
}

async function collectDatabaseConfig(detection: DetectionResult) {
  const profile = detection.type ? FRAMEWORK_PROFILES[detection.type] : null;

  let location: 'host' | 'container' | 'external' | 'none' = 'none';
  if (detection.dbType !== 'none') {
    const { dbLocation } = await inquirer.prompt([{
      type: 'list',
      name: 'dbLocation',
      message: '数据库运行在哪里?',
      choices: [
        { name: '宿主机 (直接安装在服务器上)', value: 'host' },
        { name: 'Docker 容器 (同一 compose 管理)', value: 'container' },
        { name: '外部服务 (RDS/云数据库)', value: 'external' },
      ],
    }]);
    location = dbLocation;
  }

  const { dataDir } = await inquirer.prompt([{
    type: 'input',
    name: 'dataDir',
    message: '数据持久化目录 (留空则无):',
    default: detection.dataDir || profile?.dataDir || '',
  }]);

  const { migrateCmd } = await inquirer.prompt([{
    type: 'input',
    name: 'migrateCmd',
    message: '数据库迁移命令 (留空则无):',
    default: profile?.dbMigrateCmd || '',
  }]);

  const { createAdmin } = await inquirer.prompt([{
    type: 'confirm',
    name: 'createAdmin',
    message: '首次部署是否需要创建管理员账号?',
    default: false,
  }]);

  let adminCmd = '';
  if (createAdmin) {
    const ans = await inquirer.prompt([{
      type: 'input',
      name: 'adminCmd',
      message: '创建管理员命令:',
      default: detection.type === 'django' ? 'python manage.py createsuperuser' : '',
    }]);
    adminCmd = ans.adminCmd;
  }

  return {
    type: detection.dbType,
    location,
    dataDir,
    initCmd: profile?.dbInitCmd || '',
    migrateCmd,
    createAdmin,
    adminCmd,
  };
}

async function collectBranchConfig() {
  const { production } = await inquirer.prompt([{
    type: 'input',
    name: 'production',
    message: '生产部署分支:',
    default: 'main',
  }]);

  const { hasStaging } = await inquirer.prompt([{
    type: 'confirm',
    name: 'hasStaging',
    message: '是否配置预发布分支?',
    default: false,
  }]);

  let staging: string | null = null;
  if (hasStaging) {
    const ans = await inquirer.prompt([{
      type: 'input',
      name: 'staging',
      message: '预发布分支名:',
      default: 'develop',
    }]);
    staging = ans.staging;
  }

  return { production, staging };
}

async function reviewLoop(config: CollectedConfig, detection: DetectionResult): Promise<CollectedConfig> {
  while (true) {
    console.log(chalk.cyan('\n━━━ 配置摘要 ━━━'));
    if (config.postInitAction === 'patch-server') {
      console.log('  目标: 已部署服务器安全补丁');
    } else {
      console.log(`  项目: ${config.project.name} (${config.project.type})`);
      console.log(`  端口: ${config.project.port}`);
    }
    console.log(`  服务器: ${config.server.user}@${config.server.host}:${config.server.sshPort || 22}`);
    if (config.server.sudoMode === 'tty') {
      console.log('  sudo: SSH 远程终端输入密码（不保存）');
    }
    const postInitActionLabels: Record<PostInitAction, string> = {
      none: '只生成配置',
      'setup-server': '初始化服务器 / 部署前准备',
      'patch-server': '已部署服务器只打安全补丁',
    };
    if (config.postInitAction) {
      console.log(`  下一步: ${postInitActionLabels[config.postInitAction]}`);
    }
    if (config.postInitAction === 'patch-server') {
      console.log('  部署目录: 跳过（仅打安全补丁）');
    } else {
      console.log(`  部署目录: ${config.server.deployDir}/${config.project.name}`);
    }
    if (config.domain.enabled) {
      console.log(`  域名: ${config.domain.name} (HTTPS: ${config.domain.https ? '是' : '否'})`);
    }
    console.log(`  分支: ${config.branches.production}${config.branches.staging ? ` / ${config.branches.staging}` : ''}`);
    if (config.database.dataDir) {
      console.log(`  数据目录: ${config.database.dataDir}`);
    }
    if (config.database.migrateCmd) {
      console.log(`  迁移命令: ${config.database.migrateCmd}`);
    }
    if (config.secrets.length > 0) {
      console.log(`  Secrets: ${config.secrets.join(', ')}`);
    }
    console.log(chalk.cyan('━━━━━━━━━━━━━━━━\n'));

    const { action } = await inquirer.prompt([{
      type: 'list',
      name: 'action',
      message: '确认配置?',
      choices: [
        { name: '✓ 确认，开始生成', value: 'confirm' },
        { name: '✎ 修改项目配置', value: 'project' },
        { name: '✎ 修改服务器配置', value: 'server' },
        { name: '✎ 修改域名配置', value: 'domain' },
        { name: '✗ 取消', value: 'cancel' },
      ],
    }]);

    if (action === 'confirm') return config;
    if (action === 'cancel') {
      console.log(chalk.yellow('已取消'));
      process.exit(0);
    }

    if (action === 'project') {
      const p = await collectProjectConfig(detection, config.project.name, new Set());
      config.project = p;
    } else if (action === 'server') {
      const { server, postInitAction } = await collectServerConfig();
      config.server = server;
      config.postInitAction = postInitAction;
    } else if (action === 'domain') {
      config.domain = await collectDomainConfig();
    }
  }
}
