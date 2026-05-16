import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { CollectedConfig, Scenario } from './types';
import { replacePlaceholders, readTemplate } from '../utils/template';
import { pushProxyWorkflows } from './proxy-repo';

interface GeneratedFile {
  path: string;
  backedUp: boolean;
}

export function generateFiles(config: CollectedConfig, outputDir: string): GeneratedFile[] {
  const generated: GeneratedFile[] = [];

  // 校验必填字段
  const missingFields: string[] = [];
  if (!config.project) missingFields.push('project (object)');
  if (!config.server) missingFields.push('server (object: host, user, sshKeyPath, deployDir)');
  if (!config.domain) missingFields.push('domain (object: enabled, name, https)');
  if (!config.branches) missingFields.push('branches (object: production, staging)');
  if (missingFields.length > 0) {
    throw new Error(
      `配置文件缺少必填字段，请检查 -c 传入的 config.json：\n` +
      missingFields.map(f => `  - ${f}`).join('\n')
    );
  }

  // database 字段不存在时自动填充默认值（纯静态项目可不配置数据库）
  if (!config.database) {
    config.database = {
      type: 'none',
      location: 'none',
      dataDir: '',
      initCmd: '',
      migrateCmd: '',
      createAdmin: false,
      adminCmd: '',
    };
  }

  // Check if this is proxy-service with existing-compose mode
  const isProxyService = config.project.type === 'proxy-service';
  const isExistingCompose = config.deploymentMode === 'existing-compose';
  const skipDockerFiles = isProxyService && isExistingCompose;

  const vars = buildTemplateVars(config, skipDockerFiles);

  if (!skipDockerFiles) {
    // Dockerfile
    generated.push(writeTemplate(
      getDockerfileTemplate(config.project.type, config.project.projectStructure),
      'Dockerfile',
      vars, outputDir
    ));

    // .dockerignore
    const ignoreCategory = config.project.language === 'python' ? 'python' : 'node';
    generated.push(writeTemplate(
      readTemplate('dockerignore', `${ignoreCategory}.dockerignore`),
      '.dockerignore',
      vars, outputDir
    ));

    // docker-compose.yml
    generated.push(writeTemplate(
      readTemplate('compose', 'default.yml'),
      'docker-compose.yml',
      vars, outputDir
    ));
  }

  // GitHub Actions workflows
  const workflowDir = path.join(outputDir, '.github', 'workflows');
  fs.mkdirSync(workflowDir, { recursive: true });

  if (config.proxyRepo?.enabled) {
    // Proxy mode: generate trigger workflows locally
    generated.push(writeTemplate(
      readTemplate('workflows', 'proxy-trigger-deploy.yml'),
      '.github/workflows/deploy.yml',
      vars, outputDir
    ));
    generated.push(writeTemplate(
      readTemplate('workflows', 'proxy-trigger-release.yml'),
      '.github/workflows/release.yml',
      vars, outputDir
    ));

    // Push actual workflows to proxy repo
    try {
      generateProxyWorkflows(config, vars);
    } catch (err: any) {
      console.log(chalk.yellow(`  ⚠ Proxy workflow 推送失败: ${err.message}`));
      console.log(chalk.yellow('  后续可手动运行: deploy-setup init 重试'));
    }
  } else {
    // Legacy mode: generate deploy workflow locally
    const workflowTemplate = config.strategy?.buildLocation === 'ci'
      ? 'github-deploy-ci-build.yml'
      : 'github-deploy.yml';
    generated.push(writeTemplate(
      readTemplate('workflows', workflowTemplate),
      '.github/workflows/deploy.yml',
      vars, outputDir
    ));
  }

  // Nginx config for SPA
  if (['vue-spa', 'react-spa'].includes(config.project.type)) {
    generated.push(writeTemplate(
      readTemplate('nginx', 'default.conf'),
      'nginx.conf',
      vars, outputDir
    ));
  }

  // Server init script
  generated.push(writeTemplate(
    readTemplate('scripts', 'server-init.sh'),
    'server-init.sh',
    vars, outputDir
  ));

  // Ensure .gitattributes enforces LF for .sh files
  const gitattributesPath = path.join(outputDir, '.gitattributes');
  const shRule = '*.sh text eol=lf';
  if (fs.existsSync(gitattributesPath)) {
    const existing = fs.readFileSync(gitattributesPath, 'utf-8');
    if (!/^\*\.sh\s/m.test(existing)) {
      const append = existing.endsWith('\n') ? shRule + '\n' : '\n' + shRule + '\n';
      fs.appendFileSync(gitattributesPath, append, 'utf-8');
      console.log(chalk.green(`  追加: .gitattributes (${shRule})`));
    }
  } else {
    fs.writeFileSync(gitattributesPath, shRule + '\n', 'utf-8');
    console.log(chalk.green(`  生成: .gitattributes`));
  }

  return generated;
}

/**
 * Generate and push proxy repo workflows based on detected scenario.
 */
function generateProxyWorkflows(config: CollectedConfig, vars: Record<string, string>): void {
  if (!config.proxyRepo?.enabled) return;

  const scenario: Scenario = config.scenario || 'simple-web';
  const workflows: Array<{ path: string; content: string }> = [];

  if (scenario === 'monorepo-node' || scenario === 'simple-web') {
    const template = readTemplate('workflows', 'proxy-monorepo-node.yml');
    const content = replacePlaceholders(template, vars);
    workflows.push({ path: '.github/workflows/deploy.yml', content });
  }

  if (scenario === 'tauri-desktop') {
    const template = readTemplate('workflows', 'proxy-tauri-desktop.yml');
    const content = replacePlaceholders(template, vars);
    workflows.push({ path: '.github/workflows/release.yml', content });

    // Tauri projects may also have a deploy workflow for server components
    if (config.server?.host) {
      const deployTemplate = readTemplate('workflows', 'proxy-monorepo-node.yml');
      const deployContent = replacePlaceholders(deployTemplate, vars);
      workflows.push({ path: '.github/workflows/deploy.yml', content: deployContent });
    }
  }

  pushProxyWorkflows(config.proxyRepo, workflows);
}

function buildTemplateVars(config: CollectedConfig, skipDockerFiles: boolean = false): Record<string, string> {
  const startParts = config.project.startCmd.split(/\s+/);
  const dockerCmd = startParts.map(p => `"${p}"`).join(', ');
  const serverSecurityPatchScript = replacePlaceholders(readTemplate('scripts', 'server-patch.sh'), {
    PATCH_TARGET: config.project.name || 'server',
  }).replace(/\r\n/g, '\n');

  // ENV_HARDCODED_LINES: non-sensitive vars written directly into .env
  const envHardcodedLines = Object.entries(config.envVars || {})
    .map(([k, v]) => `            ${k}=${v}`)
    .join('\n');

  // ENV_SECRET_LINES: sensitive vars injected from GitHub Secrets
  const envSecretLines = config.secrets
    .map(key => `            echo "${key}=\${{ secrets.${key} }}" >> .env`)
    .join('\n');

  // ENV_SECRET_PLACEHOLDER_LINES: empty placeholders for secrets in server-init .env
  const envSecretPlaceholderLines = config.secrets
    .map(key => `            ${key}=`)
    .join('\n');

  return {
    APP_NAME: config.project.name,
    APP_PORT: String(config.project.port),
    CONTAINER_PORT: ['vue-spa', 'react-spa'].includes(config.project.type) ? '80' : String(config.project.port),
    BUILD_CMD: config.project.buildCmd,
    START_CMD: config.project.startCmd,
    START_CMD_DOCKER: dockerCmd,
    PYTHON_VERSION: '3.11',
    NODE_VERSION: '20',

    DEPLOY_DIR: config.server.deployDir,
    SERVER_HOST: config.server.host,
    SERVER_USER: config.server.user,
    BRANCH_PRODUCTION: config.branches.production,
    DOMAIN_NAME: config.domain.name || 'localhost',
    DOMAIN_ENABLED: String(config.domain.enabled),
    HTTPS_ENABLED: String(config.domain.https),
    DB_ON_HOST: config.database.location === 'host' ? 'true' : '',
    NOT_DB_ON_HOST: config.database.location !== 'host' ? 'true' : '',
    DATA_DIR: config.database.dataDir,
    DB_MIGRATE_CMD: config.database.migrateCmd,
    DB_INIT_CMD: config.database.initCmd,
    SERVER_DIR: config.project.subDirs?.server || 'server',
    CLIENT_DIR: config.project.subDirs?.client || 'client',
    ENV_HARDCODED_LINES: envHardcodedLines,
    ENV_SECRET_LINES: envSecretLines,
    ENV_SECRET_PLACEHOLDER_LINES: envSecretPlaceholderLines,
    SERVER_SECURITY_PATCH_SCRIPT: serverSecurityPatchScript,
    DEPLOYMENT_MODE: config.deploymentMode || 'generated',
    PROXY_MODE: config.proxyMode || 'host-nginx',
    SKIP_BUILD: skipDockerFiles ? 'true' : '',
    NOT_SKIP_BUILD: skipDockerFiles ? '' : 'true',

    // Strategy-related vars
    BUILD_ON_CI: config.strategy?.buildLocation === 'ci' ? 'true' : '',
    BUILD_ON_SERVER: config.strategy?.buildLocation !== 'ci' ? 'true' : '',
    TRANSFER_SCP: config.strategy?.transferMethod === 'scp' ? 'true' : '',

    // Mirror vars
    MIRROR_ALPINE: config.strategy?.mirrors?.alpine || '',
    MIRROR_NPM: config.strategy?.mirrors?.npm || '',
    MIRROR_PIP: config.strategy?.mirrors?.pip || '',

    // Docker mirror for daemon.json (pre-formatted as JSON array items)
    MIRROR_DOCKER: (config.strategy?.mirrors?.docker || [])
      .map(m => `"https://${m}"`)
      .join(', '),

    // Native module build tools
    NEEDS_BUILD_TOOLS: config.strategy?.needsBuildTools ? 'true' : '',

    // Deploy timeout — dynamic based on probe (15min default, 25min for
    // China mirrors or resource-constrained servers)
    DEPLOY_TIMEOUT: `${config.strategy?.deployTimeoutMinutes ?? 15}m`,
    DEPLOY_TIMEOUT_MINUTES: String(config.strategy?.deployTimeoutMinutes ?? 20),

    // Proxy repo vars
    PROXY_REPO_OWNER: config.proxyRepo?.owner || '',
    PROXY_REPO_NAME: config.proxyRepo?.repo || '',
    CHECKOUT_TOKEN_SECRET: config.proxyRepo?.checkoutTokenSecret || 'GH_RELEASE_REPO_TOKEN',
    SCENARIO: config.scenario || 'simple-web',

    // Monorepo proxy vars
    COMPOSE_FILE: 'docker-compose.prod.yml',
    SERVER_BUILD_CMD: config.project.buildCmd ? `pnpm --filter server build` : '',
    ADMIN_BUILD_CMD: '',
    ENV_PROXY_SECRET_ENV_BLOCK: config.secrets
      .map(key => `          ${key}: \${{ secrets.${key} }}`)
      .join('\n'),
    ENV_PROXY_WRITE_BLOCK: [
      ...Object.entries(config.envVars || {}).map(([k, v]) => `          echo "${k}=${v}" >> .env`),
      ...config.secrets.map(key => `          echo "${key}=\${${key}}" >> .env`),
    ].join('\n'),
    HEALTH_PATH: '',
    NGINX_SYNC_CMD: '',
  };
}

function getDockerfileTemplate(type: string, projectStructure?: string): string {
  if (projectStructure === 'multi-dir') {
    return readTemplate('dockerfile', 'multi-dir.Dockerfile');
  }
  if (type === 'nextjs') {
    return readTemplate('dockerfile', 'next-standalone.Dockerfile');
  }
  if (['flask', 'django', 'fastapi'].includes(type)) {
    return readTemplate('dockerfile', 'python.Dockerfile');
  }
  if (['vue-spa', 'react-spa'].includes(type)) {
    return readTemplate('dockerfile', 'spa.Dockerfile');
  }
  return readTemplate('dockerfile', 'node.Dockerfile');
}

function writeTemplate(
  template: string,
  relativePath: string,
  vars: Record<string, string>,
  outputDir: string
): GeneratedFile {
  let content = replacePlaceholders(template, vars);
  const fullPath = path.join(outputDir, relativePath);

  // Ensure .sh files always use LF line endings (CRLF breaks bash on Linux)
  if (relativePath.endsWith('.sh')) {
    content = content.replace(/\r\n/g, '\n');
  }
  let backedUp = false;

  // Backup existing file
  if (fs.existsSync(fullPath)) {
    fs.copyFileSync(fullPath, fullPath + '.backup');
    backedUp = true;
    console.log(chalk.yellow(`  备份: ${relativePath} → ${relativePath}.backup`));
  }

  // Ensure directory exists
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf-8');
  console.log(chalk.green(`  生成: ${relativePath}`));

  return { path: relativePath, backedUp };
}
