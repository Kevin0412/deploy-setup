import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as path from 'path';
import * as fs from 'fs';
import * as dns from 'dns';
import { detectProject } from './core/detector';
import { collectConfig } from './core/collector';
import { generateFiles } from './core/generator';
import { probeServer } from './core/prober';
import { selectStrategy } from './core/strategy';
import { saveProjectRecord } from './utils/config-store';
import { saveCache, loadCache, loadDeployConfig, saveDeployConfig } from './utils/cache';
import { CollectedConfig, EXIT_CONFIG_ERROR, EXIT_NETWORK_ERROR, EXIT_PROXY_REPO_FAILED } from './core/types';
import { diffEnvKeys, patchDeployYml } from './core/env-sync';
import { acquireServerLock } from './utils/deploy-lock';
import { redeployProject } from './core/redeployer';
import { deriveProxyRepoConfig } from './core/strategy';
import { redirectConsoleToStderr, emitJsonSuccess, emitJsonError } from './utils/json-output';
import { patchServer } from './core/patcher';
import { normalizeSshPort, resolveSshKeyPath, runRemoteScript } from './utils/ssh-runner';

const packageJson = require('../package.json');
const program = new Command();

program
  .name('deploy-setup')
  .description('通用 CI/CD 配置生成工具 - git push 即部署到 Linux VPS')
  .version(packageJson.version);

// ─── all (一键部署) ───
program
  .command('all')
  .description('一键完成全部配置并部署（init → DNS → 服务器 → Secrets → push）')
  .option('-d, --dir <dir>', '项目目录', process.cwd())
  .option('-c, --config <file>', '使用 JSON 配置文件（跳过交互）')
  .option('-k, --key <path>', 'SSH 私钥文件路径')
  .option('-P, --port <port>', 'SSH 端口')
  .option('-e, --env-file <path>', '从文件读取密钥值（跳过交互输入）')
  .option('--unattended', '非交互模式（需配合 -c 使用）')
  .option('--json', '结构化 JSON 输出（stdout = JSON，stderr = 日志）')
  .option('--legacy', '使用传统模式（不走 proxy repo）')
  .action(async (options) => {
    if (options.json) redirectConsoleToStderr();
    const projectDir = path.resolve(options.dir);

    console.log(chalk.cyan.bold('\n🚀 deploy-setup - 一键部署\n'));

    // Step 1: init
    const config = await runInit(projectDir, options.config, { legacy: options.legacy, json: options.json });

    // Step 2: check-dns (non-blocking)
    await runCheckDns(projectDir);

    // Step 3: setup-server
    await runSetupServer(projectDir, options.key, options.port);

    // Step 4: setup-secrets
    await runSetupSecrets(projectDir, options.key, options.envFile, options.port);

    // Step 5: git push (skip in unattended mode)
    if (!options.unattended) {
      await runPushAndVerify(projectDir, config.branches.production);
    }

    console.log(chalk.green.bold('\n✅ 部署完成! 后续 git push 即自动部署。\n'));
  });

// ─── init ───
program
  .command('init')
  .description('初始化 CI/CD 配置（交互式）')
  .option('-d, --dir <dir>', '项目目录', process.cwd())
  .option('-c, --config <file>', '使用 JSON 配置文件（跳过交互）')
  .option('--unattended', '非交互模式（需配合 -c 使用）')
  .option('--json', '结构化 JSON 输出（stdout = JSON，stderr = 日志）')
  .option('--legacy', '使用传统模式（不走 proxy repo）')
  .action(async (options) => {
    if (options.json) redirectConsoleToStderr();
    const projectDir = path.resolve(options.dir);
    console.log(chalk.cyan.bold('\n🚀 deploy-setup - CI/CD 配置生成器\n'));
    const config = await runInit(projectDir, options.config, { legacy: options.legacy, json: options.json });

    if (options.json) {
      const proxyRepo = config.proxyRepo;
      emitJsonSuccess({
        proxyRepo: proxyRepo?.enabled ? {
          owner: proxyRepo.owner,
          repo: proxyRepo.repo,
          created: false,
          workflowUpdated: false,
          workflows: [],
        } : undefined,
        nextStep: 'push-and-verify',
        secretsRequired: [
          ...(proxyRepo?.enabled ? [proxyRepo.checkoutTokenSecret] : []),
          'SERVER_HOST', 'SERVER_USER', 'SERVER_PORT', 'SSH_PRIVATE_KEY',
        ],
      });
    } else {
      if (!options.unattended) {
        await promptPostInitAction(projectDir, config);
      }
      printNextSteps(config);
    }
  });

// ─── check-dns ───
program
  .command('check-dns')
  .description('检查域名 DNS 解析是否正确')
  .option('-d, --dir <dir>', '项目目录', process.cwd())
  .action(async (options) => {
    await runCheckDns(path.resolve(options.dir));
  });

// ─── setup-server ───
program
  .command('setup-server')
  .description('SSH 到服务器执行初始化脚本')
  .option('-d, --dir <dir>', '项目目录', process.cwd())
  .option('-k, --key <path>', 'SSH 私钥文件路径')
  .option('-P, --port <port>', 'SSH 端口')
  .action(async (options) => {
    await runSetupServer(path.resolve(options.dir), options.key, options.port);
  });

// ─── patch-server ───
program
  .command('patch-server')
  .alias('patch')
  .description('对已部署服务器应用安全补丁（不重新初始化或部署）')
  .option('-d, --dir <dir>', '项目目录', process.cwd())
  .option('-c, --config <path>', 'deploy config 路径（默认 .deploy/config.json，回退 .deploy-setup-cache.json）')
  .option('-k, --key <path>', 'SSH 私钥文件路径')
  .option('-P, --port <port>', 'SSH 端口')
  .option('--dry-run', '仅输出将执行的补丁脚本，不连接服务器', false)
  .action(async (options) => {
    const projectDir = path.resolve(options.dir);
    const config = loadDeployConfig(projectDir, options.config);
    await runPatchServer(projectDir, config, options.key, options.port, options.dryRun);
  });

// ─── setup-secrets ───
program
  .command('setup-secrets')
  .description('使用 gh CLI 配置 GitHub Secrets')
  .option('-d, --dir <dir>', '项目目录', process.cwd())
  .option('-k, --key <path>', 'SSH 私钥文件路径')
  .option('-P, --port <port>', 'SSH 端口')
  .option('-e, --env-file <path>', '从文件读取密钥值（跳过交互输入）')
  .action(async (options) => {
    await runSetupSecrets(path.resolve(options.dir), options.key, options.envFile, options.port);
  });

// ─── detect ───
program
  .command('detect')
  .description('自动检测项目信息')
  .option('-d, --dir <dir>', '项目目录', process.cwd())
  .option('--json', '输出 JSON 格式')
  .action(async (options) => {
    const projectDir = path.resolve(options.dir);
    const detection = detectProject(projectDir);

    if (options.json) {
      console.log(JSON.stringify(detection, null, 2));
    } else {
      console.log(chalk.cyan.bold('\n📋 项目检测结果\n'));
      console.log(chalk.gray('项目类型:'), detection.type || '未知');
      console.log(chalk.gray('语言:'), detection.language || '未知');
      console.log(chalk.gray('默认端口:'), detection.port);
      console.log(chalk.gray('启动命令:'), detection.startCmd || '未设置');
      if (detection.buildCmd) {
        console.log(chalk.gray('构建命令:'), detection.buildCmd);
      }
      if (detection.envKeys.length > 0) {
        console.log(chalk.gray('环境变量:'), detection.envKeys.join(', '));
      }
      if (detection.dbType !== 'none') {
        console.log(chalk.gray('数据库:'), detection.dbType);
        console.log(chalk.gray('ORM:'), detection.ormTool);
      }
      console.log('');
    }
  });

// ─── probe ───
program
  .command('probe')
  .description('探测服务器环境（内存、网络、Docker 等）')
  .option('-d, --dir <dir>', '项目目录', process.cwd())
  .option('--json', '输出 JSON 格式')
  .action(async (options) => {
    const projectDir = path.resolve(options.dir);
    const config = loadCache(projectDir);

    const spinner = ora('探测服务器环境...').start();
    const probe = probeServer(config.server);
    spinner.succeed('探测完成');

    if (options.json) {
      console.log(JSON.stringify(probe, null, 2));
    } else {
      console.log(chalk.cyan.bold('\n🔍 服务器探测结果\n'));
      console.log(chalk.gray('内存:'), `${probe.memoryMB} MB`);
      console.log(chalk.gray('CPU:'), `${probe.cpuCores} 核`);
      console.log(chalk.gray('磁盘:'), `${probe.diskFreeGB} GB 可用`);
      console.log(chalk.gray('Docker:'), probe.dockerInstalled ? '已安装' : '未安装');
      console.log(chalk.gray('Docker Compose:'), probe.dockerComposeInstalled ? '已安装' : '未安装');
      console.log(chalk.gray('Docker Hub:'), probe.dockerHubReachable ? '可达' : '不可达');
      console.log(chalk.gray('npm:'), probe.npmReachable ? '可达' : '不可达');
      console.log(chalk.gray('Alpine:'), probe.alpineReachable ? '可达' : '不可达');
      console.log(chalk.gray('地区:'), probe.geoCountry);
      console.log(chalk.gray('需要中国镜像:'), probe.needsChinaMirrors ? '是' : '否');
      console.log('');
    }
  });

// ─── sync-env ───
program
  .command('sync-env')
  .description('同步 .env 变量到 GitHub Secrets 和 deploy.yml')
  .option('-d, --dir <dir>', '项目目录', process.cwd())
  .option('-e, --env-file <path>', '从文件读取密钥值')
  .option('--dry-run', '仅显示差异，不修改', false)
  .option('-y, --yes', '跳过交互，自动用正则分类 secret/hardcoded', false)
  .option('--push-secrets', '自动推送新 secrets 到 GitHub', false)
  .action(async (options) => {
    const projectDir = path.resolve(options.dir);
    await runSyncEnv(projectDir, options);
  });

// ─── redeploy ───
program
  .command('redeploy')
  .description('触发 CI workflow_dispatch 重新部署（代码不变）')
  .option('-c, --config <path>', 'deploy config 路径', '.deploy/config.json')
  .option('-w, --workflow <name>', '指定 workflow 文件名', '')
  .action(async (opts) => {
    await redeployProject({
      configPath: opts.config,
      workflow: opts.workflow || undefined,
    });
  });

// ─── parse ───
program.parse(process.argv);

// ─── core functions ───

interface InitOptions {
  legacy?: boolean;
  json?: boolean;
}

async function runInit(projectDir: string, configFile?: string, initOptions?: InitOptions): Promise<CollectedConfig> {
  const projectName = path.basename(projectDir).toLowerCase().replace(/[^a-z0-9-]/g, '-');

  const spinner = ora('检测项目类型...').start();
  const detection = detectProject(projectDir);
  spinner.succeed(
    detection.type
      ? `检测到: ${detection.type} (${detection.language})`
      : '未能自动检测项目类型'
  );

  if (detection.hasDocker) console.log(chalk.yellow('  ⚠ 已存在 Dockerfile，将备份后覆盖'));
  if (detection.hasCI) console.log(chalk.yellow('  ⚠ 已存在 GitHub Actions 配置，将备份后覆盖'));

  let config: CollectedConfig;
  if (configFile) {
    config = JSON.parse(fs.readFileSync(path.resolve(configFile), 'utf-8'));
    console.log(chalk.green(`  使用配置文件: ${path.resolve(configFile)}`));
  } else {
    config = await collectConfig(detection, projectName);
  }

  if (config.postInitAction === 'patch-server') {
    console.log(chalk.cyan('\n📦 保存补丁配置...\n'));
    saveCache(projectDir, config);
    saveDeployConfig(projectDir, config);
    return config;
  }

  // Derive proxy repo config (default: enabled, unless --legacy)
  const { execSync: execSyncLocal } = require('child_process');
  let repoOwner = '';
  let repoName = '';
  try {
    const remoteUrl = execSyncLocal('gh repo view --json owner,name -q ".owner.login + \\" \\" + .name"', {
      cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const parts = remoteUrl.split(' ');
    repoOwner = parts[0] || '';
    repoName = parts[1] || '';
  } catch {
    // Fallback: parse from git remote
    try {
      const remote = execSyncLocal('git remote get-url origin', {
        cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      const match = remote.match(/[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/);
      if (match) {
        repoOwner = match[1];
        repoName = match[2];
      }
    } catch { /* no git remote */ }
  }

  config.proxyRepo = deriveProxyRepoConfig({
    legacy: initOptions?.legacy,
    repoOwner,
    repoName,
  });

  if (config.proxyRepo.enabled) {
    console.log(chalk.cyan(`\n🔀 Proxy Repo 模式: ${config.proxyRepo.owner}/${config.proxyRepo.repo}`));
  }

  // Probe server and select strategy (if server config is available)
  if (config.server?.host) {
    const probeSpinner = ora('探测服务器环境...').start();
    try {
      const probe = probeServer(config.server);
      probeSpinner.succeed('服务器探测完成');

      const strategy = selectStrategy(probe, detection);
      config.strategy = strategy;
    } catch (err: any) {
      probeSpinner.warn(`服务器探测失败: ${err.message}，使用默认策略（服务器构建）`);
    }
  }

  console.log(chalk.cyan('\n📦 生成配置文件...\n'));
  generateFiles(config, projectDir);

  saveProjectRecord(config.project.name, config.project.type);
  saveCache(projectDir, config);
  saveDeployConfig(projectDir, config);

  return config;
}

async function runCheckDns(projectDir: string): Promise<void> {
  const config = loadCache(projectDir);

  if (!config.domain.enabled) {
    console.log(chalk.yellow('未配置域名，跳过 DNS 检查'));
    return;
  }

  const domain = config.domain.name;
  const expectedIp = config.server.host;

  console.log(chalk.cyan(`\n🔍 检查 DNS: ${domain} → ${expectedIp}\n`));

  try {
    const addresses = await new Promise<string[]>((resolve, reject) => {
      dns.resolve4(domain, (err, addrs) => err ? reject(err) : resolve(addrs));
    });

    if (addresses.includes(expectedIp)) {
      console.log(chalk.green(`  ✔ DNS 正确: ${domain} → ${addresses.join(', ')}`));
    } else {
      console.log(chalk.yellow(`  ⚠ DNS 不匹配 (当前: ${addresses.join(', ')}，期望: ${expectedIp})`));
      console.log(chalk.yellow('  部署将继续，但域名访问可能不可用'));
    }
  } catch (err: any) {
    console.log(chalk.yellow(`  ⚠ DNS 查询失败: ${err.message}，跳过`));
  }
}

async function promptPostInitAction(projectDir: string, config: CollectedConfig): Promise<void> {
  if (config.postInitAction) {
    if (config.postInitAction === 'setup-server') {
      await runSetupServer(projectDir);
    } else if (config.postInitAction === 'patch-server') {
      await runPatchServer(projectDir, config);
    }
    return;
  }

  const inquirer = require('inquirer');
  const { action } = await inquirer.prompt([{
    type: 'list',
    name: 'action',
    message: '配置生成完成，下一步执行什么?',
    choices: [
      { name: '暂不执行，只生成配置文件', value: 'none' },
      { name: '初始化服务器 / 部署前准备（setup-server，包含安全补丁）', value: 'setup-server' },
      { name: '只给已部署服务器打安全补丁（patch-server）', value: 'patch-server' },
    ],
    default: 'none',
  }]);

  if (action === 'setup-server') {
    await runSetupServer(projectDir);
  } else if (action === 'patch-server') {
    await runPatchServer(projectDir, config);
  }
}

async function runSetupServer(projectDir: string, keyPath?: string, sshPort?: number | string): Promise<void> {
  const config = loadCache(projectDir);
  const scriptPath = path.join(projectDir, 'server-init.sh');

  if (!fs.existsSync(scriptPath)) {
    throw new Error('server-init.sh 不存在，请先运行 deploy-setup init');
  }

  const os = require('os');
  const server = {
    ...config.server,
    sshKeyPath: keyPath || config.server.sshKeyPath,
    sshPort: sshPort ? normalizeSshPort(sshPort) : normalizeSshPort(config.server.sshPort),
  };
  const { host, user } = server;
  const resolvedKeyPath = resolveSshKeyPath(server.sshKeyPath);

  console.log(chalk.cyan(`\n🖥  连接服务器: ${user}@${host}:${server.sshPort}\n`));
  console.log(chalk.gray(`  使用密钥: ${resolvedKeyPath}`));
  if (server.sudoMode === 'tty') {
    console.log(chalk.gray('  sudo 模式: SSH 远程终端输入密码（不保存）'));
  }

  // Acquire a server-side atomic lock so two concurrent `deploy-setup`
  // invocations (from parallel agents or different machines) can't race
  // during setup-server. The GH Actions workflow separately handles the
  // actual deploy stage's concurrency; this lock only covers the CLI's
  // remote init phase.
  const lockHolder = `${os.userInfo().username}@${os.hostname()} (deploy-setup pid=${process.pid})`;
  const lock = acquireServerLock({
    host,
    user,
    sshKeyPath: resolvedKeyPath,
    sshPort: server.sshPort,
    projectName: config.project.name || 'default',
    holderHint: lockHolder,
    staleSeconds: 1800,
  });
  console.log(chalk.gray(`  🔒 已获取服务器部署锁 (/tmp/deploy-setup-lock-${config.project.name || 'default'})`));

  // Convert CRLF to LF for Linux compatibility.
  const scriptContent = fs.readFileSync(scriptPath, 'utf-8').replace(/\r\n/g, '\n');

  try {
    runRemoteScript({
      host,
      user,
      sshKeyPath: resolvedKeyPath,
      sshPort: server.sshPort,
      script: scriptContent,
      cwd: projectDir,
      timeoutMs: 600000,
      tty: server.sudoMode === 'tty',
      label: 'server-init',
    });
    console.log(chalk.green('  ✔ 服务器初始化完成'));
  } finally {
    try {
      lock.release();
      console.log(chalk.gray('  🔓 已释放服务器部署锁'));
    } catch (err: any) {
      console.log(chalk.yellow(`  ⚠ 释放锁失败（仍会继续）: ${err.message}`));
    }
  }
}

async function runPatchServer(
  projectDir: string,
  config: CollectedConfig,
  keyPath?: string,
  sshPort?: number | string,
  dryRun?: boolean,
): Promise<void> {
  const port = sshPort ? normalizeSshPort(sshPort) : normalizeSshPort(config.server.sshPort);
  console.log(chalk.cyan(`\n🩹 应用服务器安全补丁: ${config.server.user}@${config.server.host}:${port}\n`));
  if (config.server.sudoMode === 'tty') {
    console.log(chalk.gray('  sudo 模式: SSH 远程终端输入密码（不保存）'));
  }
  patchServer({ config, projectDir, keyPath, sshPort: port, dryRun });
  if (!dryRun) {
    console.log(chalk.green('\n✅ 服务器补丁完成'));
  }
}

async function runSetupSecrets(
  projectDir: string,
  keyPath?: string,
  envFilePath?: string,
  sshPort?: number | string,
): Promise<void> {
  const config = loadCache(projectDir);
  const { execSync } = require('child_process');

  // Check gh CLI
  try {
    execSync('gh --version', { stdio: 'ignore' });
  } catch {
    console.log(chalk.yellow('未检测到 gh CLI，正在自动安装...'));
    try {
      await installGhCli();
      console.log(chalk.green('  ✔ gh CLI 安装成功'));
    } catch (err: any) {
      throw new Error(`gh CLI 自动安装失败: ${err.message}\n  请手动安装: https://cli.github.com`);
    }
  }

  // Check gh auth
  try {
    execSync('gh auth status', { stdio: 'ignore', cwd: projectDir });
  } catch {
    console.log(chalk.yellow('gh 未登录，正在启动登录流程 (SSH 协议)...'));
    execSync('gh auth login --git-protocol ssh', { stdio: 'inherit', cwd: projectDir });
  }

  // Parse env-file if provided
  let envFileMap: Record<string, string> = {};
  if (envFilePath) {
    const resolvedEnvFile = envFilePath.replace(/^~/, require('os').homedir());
    if (fs.existsSync(resolvedEnvFile)) {
      const content = fs.readFileSync(resolvedEnvFile, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        envFileMap[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
      }
      console.log(chalk.green(`  已加载 env-file: ${resolvedEnvFile} (${Object.keys(envFileMap).length} 个变量)`));
    } else {
      console.log(chalk.yellow(`  ⚠ env-file 不存在: ${resolvedEnvFile}，将回退到交互输入`));
    }
  }

  // Determine target repo for secrets
  const proxyEnabled = config.proxyRepo?.enabled;
  const targetRepo = proxyEnabled
    ? `${config.proxyRepo!.owner}/${config.proxyRepo!.repo}`
    : undefined;

  if (proxyEnabled) {
    console.log(chalk.cyan(`\n🔑 配置 GitHub Secrets → ${targetRepo}\n`));
  } else {
    console.log(chalk.cyan('\n🔑 配置 GitHub Secrets\n'));
  }

  const repoFlag = targetRepo ? `--repo ${targetRepo}` : '';

  const secrets: Record<string, string> = {
    SERVER_HOST: config.server.host,
    SERVER_USER: config.server.user,
    SERVER_PORT: String(sshPort ? normalizeSshPort(sshPort) : normalizeSshPort(config.server.sshPort)),
  };

  // Resolve SSH private key
  let resolvedKeyPath = keyPath || config.server.sshKeyPath;
  if (!resolvedKeyPath) {
    const inquirer = require('inquirer');
    const answer = await inquirer.prompt([{
      type: 'input', name: 'keyPath',
      message: 'SSH 私钥文件路径:', default: '~/.ssh/id_ed25519',
    }]);
    resolvedKeyPath = answer.keyPath;
  }

  const fullKeyPath = resolveSshKeyPath(resolvedKeyPath);
  if (fs.existsSync(fullKeyPath)) {
    secrets['SSH_PRIVATE_KEY'] = fs.readFileSync(fullKeyPath, 'utf-8');
  } else {
    console.log(chalk.yellow(`  ⚠ 私钥文件不存在: ${fullKeyPath}，跳过 SSH_PRIVATE_KEY`));
  }

  for (const [name, value] of Object.entries(secrets)) {
    try {
      execSync(`gh secret set ${name} ${repoFlag}`, {
        input: value, cwd: projectDir,
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      console.log(chalk.green(`  ✔ ${name}`));
    } catch (err: any) {
      console.log(chalk.red(`  ✗ ${name}: ${err.message}`));
    }
  }

  // If proxy repo is enabled, also set the checkout token secret on the PROJECT repo
  // (the trigger workflow needs it to dispatch to the proxy repo)
  if (proxyEnabled && config.proxyRepo) {
    const tokenSecretName = config.proxyRepo.checkoutTokenSecret;
    console.log(chalk.cyan(`\n  ⚠ 还需要在项目仓库设置 ${tokenSecretName} (GitHub PAT with repo scope)`));
    console.log(chalk.gray(`    gh secret set ${tokenSecretName}  ← 粘贴你的 GitHub PAT`));
  }

  // Business secrets from .env (config.secrets)
  const infraKeys = new Set(['SERVER_HOST', 'SERVER_USER', 'SERVER_PORT', 'SSH_PRIVATE_KEY']);
  const businessKeys = (config.secrets || []).filter((k: string) => !infraKeys.has(k));

  if (businessKeys.length > 0) {
    console.log(chalk.cyan('\n🔐 配置业务密钥\n'));

    if (Object.keys(envFileMap).length > 0) {
      // Auto-inject from env-file
      for (const key of businessKeys) {
        const value = envFileMap[key];
        if (value) {
          try {
            execSync(`gh secret set ${key} ${repoFlag}`, {
              input: value, cwd: projectDir,
              stdio: ['pipe', 'ignore', 'pipe'],
            });
            console.log(chalk.green(`  ✔ ${key} (from env-file)`));
          } catch (err: any) {
            console.log(chalk.red(`  ✗ ${key}: ${err.message}`));
          }
        } else {
          console.log(chalk.yellow(`  ⏭ ${key}: 未在 env-file 中找到，跳过`));
        }
      }
    } else {
      // Interactive input
      const inquirer = require('inquirer');

      for (const key of businessKeys) {
        const { value } = await inquirer.prompt([{
          type: 'password',
          name: 'value',
          message: `${key}:`,
          mask: '*',
        }]);

        if (!value) {
          console.log(chalk.yellow(`  ⏭ ${key}: 值为空，已跳过`));
          continue;
        }

        try {
          execSync(`gh secret set ${key} ${repoFlag}`, {
            input: value, cwd: projectDir,
            stdio: ['pipe', 'ignore', 'pipe'],
          });
          console.log(chalk.green(`  ✔ ${key}`));
        } catch (err: any) {
          console.log(chalk.red(`  ✗ ${key}: ${err.message}`));
        }
      }
    }
  }

  console.log(chalk.green('\n✅ Secrets 配置完成'));
}

async function runPushAndVerify(projectDir: string, branch: string): Promise<void> {
  const { execSync } = require('child_process');
  const config = loadCache(projectDir);

  console.log(chalk.cyan(`\n📤 推送到 GitHub (${branch})\n`));

  try {
    execSync('git add .', { cwd: projectDir, stdio: 'pipe' });
    execSync('git commit -m "add CI/CD config (deploy-setup)"', { cwd: projectDir, stdio: 'pipe' });
    console.log(chalk.green('  ✔ 已提交'));
  } catch {
    console.log(chalk.yellow('  无新变更需要提交，继续推送'));
  }

  execSync(`git push origin ${branch}`, { cwd: projectDir, stdio: 'inherit' });
  console.log(chalk.green('  ✔ 已推送'));

  // Determine which repo to monitor for Actions runs
  const proxyEnabled = config.proxyRepo?.enabled;
  const monitorRepo = proxyEnabled
    ? `${config.proxyRepo!.owner}/${config.proxyRepo!.repo}`
    : undefined;
  const repoFlag = monitorRepo ? `--repo ${monitorRepo}` : '';
  const monitorTarget = monitorRepo || '当前仓库';

  // Wait for Actions run
  console.log(chalk.cyan(`\n⏳ 等待 GitHub Actions 运行... (${monitorTarget})\n`));
  await new Promise(r => setTimeout(r, proxyEnabled ? 10000 : 5000));

  for (let i = 0; i < 30; i++) {
    try {
      const result = execSync(`gh run list --limit 1 --json status,conclusion,name ${repoFlag}`, {
        cwd: projectDir, encoding: 'utf-8',
      });
      const runs = JSON.parse(result);
      if (runs.length > 0) {
        const run = runs[0];
        if (run.status === 'completed') {
          if (run.conclusion === 'success') {
            console.log(chalk.green(`  ✔ Actions 运行成功: ${run.name}`));
          } else {
            console.log(chalk.red(`  ✗ Actions 运行失败: ${run.name} (${run.conclusion})`));
            console.log(chalk.yellow(`  运行 gh run view --log-failed ${repoFlag} 查看详情`));
          }
          return;
        }
        console.log(chalk.gray(`  运行中... (${run.status})`));
      }
    } catch {
      // gh not available, skip verification
      console.log(chalk.yellow('  无法查询 Actions 状态，请手动检查'));
      return;
    }
    await new Promise(r => setTimeout(r, 10000));
  }

  console.log(chalk.yellow('  等待超时，请手动检查 Actions 状态'));
}

async function installGhCli(): Promise<void> {
  const { execSync } = require('child_process');
  const platform = process.platform;

  if (platform === 'win32') {
    execSync('winget install --id GitHub.cli -e --source winget', { stdio: 'inherit' });
  } else if (platform === 'darwin') {
    execSync('brew install gh', { stdio: 'inherit' });
  } else {
    // Linux
    execSync(
      'type -p curl >/dev/null || (apt-get update && apt-get install curl -y) && '
      + 'curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && '
      + 'chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && '
      + 'echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && '
      + 'apt-get update && apt-get install gh -y',
      { stdio: 'inherit' }
    );
  }
}

async function runSyncEnv(projectDir: string, options: { dryRun?: boolean; yes?: boolean; pushSecrets?: boolean; envFile?: string }): Promise<void> {
  console.log(chalk.cyan.bold('\n🔄 deploy-setup sync-env - 环境变量同步\n'));

  // 1. Load cached config
  let config: CollectedConfig;
  try {
    config = loadCache(projectDir);
  } catch {
    console.log(chalk.red('未找到配置缓存，请先运行 deploy-setup init'));
    process.exit(1);
  }

  // 2. Re-detect .env
  const spinner = ora('扫描 .env 文件...').start();
  const detection = detectProject(projectDir);
  spinner.succeed(
    detection.envFile
      ? `找到: ${detection.envFile} (${detection.envKeys.length} 个变量)`
      : '未找到 .env 文件'
  );

  if (!detection.envFile || detection.envKeys.length === 0) {
    console.log(chalk.yellow('没有环境变量可同步'));
    return;
  }

  // 3. Diff
  const diff = diffEnvKeys(detection.envKeys, config);

  console.log(chalk.cyan('\n━━━ 变量差异 ━━━'));
  if (diff.added.length > 0) {
    console.log(chalk.green(`  新增 (${diff.added.length}):`));
    diff.added.forEach(k => console.log(chalk.green(`    + ${k}`)));
  }
  if (diff.removed.length > 0) {
    console.log(chalk.red(`  移除 (${diff.removed.length}):`));
    diff.removed.forEach(k => console.log(chalk.red(`    - ${k}`)));
  }
  if (diff.unchanged.length > 0) {
    console.log(chalk.gray(`  不变 (${diff.unchanged.length}):`));
    diff.unchanged.forEach(k => console.log(chalk.gray(`    = ${k}`)));
  }
  console.log(chalk.cyan('━━━━━━━━━━━━━━━━\n'));

  if (diff.added.length === 0 && diff.removed.length === 0) {
    console.log(chalk.green('环境变量无变化，无需同步'));
    return;
  }

  if (options.dryRun) {
    console.log(chalk.yellow('--dry-run 模式，不执行任何修改'));
    return;
  }

  // 4. Classify new keys as secret or hardcoded
  if (diff.added.length > 0) {
    let newSecretSet: Set<string>;

    if (options.yes) {
      // Auto-classify using regex heuristic
      newSecretSet = new Set(diff.added.filter((k: string) => /secret|password|key|token|api/i.test(k)));
      console.log(chalk.gray('  --yes 模式，自动分类:'));
      for (const key of diff.added) {
        const label = newSecretSet.has(key) ? 'SECRET' : 'HARDCODED';
        console.log(chalk.gray(`    ${key} => ${label}`));
      }
    } else {
      const inquirer = require('inquirer');
      const { newSecrets } = await inquirer.prompt([{
        type: 'checkbox',
        name: 'newSecrets',
        message: '选择新增变量中需要作为 GitHub Secrets 的敏感变量:',
        choices: diff.added.map((k: string) => ({
          name: k,
          value: k,
          checked: /secret|password|key|token|api/i.test(k),
        })),
      }]);
      newSecretSet = new Set(newSecrets as string[]);
    }

    if (!config.envVars) config.envVars = {};
    for (const key of diff.added) {
      if (newSecretSet.has(key)) {
        config.secrets.push(key);
      } else {
        config.envVars[key] = detection.envPairs[key] || '';
      }
    }
  }

  // 5. Handle removed keys
  if (diff.removed.length > 0) {
    let confirmRemove = true;

    if (!options.yes) {
      const inquirer = require('inquirer');
      const answer = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirmRemove',
        message: `确认移除 ${diff.removed.length} 个不再使用的变量?`,
        default: true,
      }]);
      confirmRemove = answer.confirmRemove;
    } else {
      console.log(chalk.gray(`  --yes 模式，自动移除 ${diff.removed.length} 个变量`));
    }

    if (confirmRemove) {
      const removedSet = new Set(diff.removed);
      config.secrets = config.secrets.filter((k: string) => !removedSet.has(k));
      for (const key of diff.removed) {
        delete config.envVars[key];
      }
    }
  }

  // 6. Patch deploy.yml
  const deployYmlPath = path.join(projectDir, '.github', 'workflows', 'deploy.yml');
  if (fs.existsSync(deployYmlPath)) {
    const patchSpinner = ora('更新 deploy.yml...').start();
    try {
      const content = fs.readFileSync(deployYmlPath, 'utf-8');
      const patched = patchDeployYml(content, config.envVars, config.secrets);
      fs.writeFileSync(deployYmlPath, patched, 'utf-8');
      patchSpinner.succeed('deploy.yml 已更新');
    } catch (err: any) {
      patchSpinner.fail(`deploy.yml 更新失败: ${err.message}`);
    }
  } else {
    console.log(chalk.yellow('  未找到 deploy.yml，跳过 workflow 更新'));
  }

  // 7. Save cache + reusable .deploy/config.json
  saveCache(projectDir, config);
  saveDeployConfig(projectDir, config);
  console.log(chalk.green('  配置已保存'));

  // 8. Push secrets
  if (options.pushSecrets && diff.added.length > 0) {
    const { execSync } = require('child_process');
    const newSecretKeys = diff.added.filter((k: string) => config.secrets.includes(k));

    if (newSecretKeys.length > 0) {
      // Parse env-file if provided
      let envFileMap: Record<string, string> = {};
      if (options.envFile) {
        const resolvedEnvFile = options.envFile.replace(/^~/, require('os').homedir());
        if (fs.existsSync(resolvedEnvFile)) {
          const efContent = fs.readFileSync(resolvedEnvFile, 'utf-8');
          for (const line of efContent.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx === -1) continue;
            envFileMap[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
          }
        }
      }

      // Also read from detected .env as fallback
      const detectedEnvMap = detection.envPairs;

      // Push to proxy repo if enabled
      const syncRepoFlag = config.proxyRepo?.enabled
        ? `--repo ${config.proxyRepo.owner}/${config.proxyRepo.repo}`
        : '';
      const syncTarget = config.proxyRepo?.enabled
        ? `${config.proxyRepo.owner}/${config.proxyRepo.repo}`
        : 'GitHub';
      console.log(chalk.cyan(`\n🔑 推送新 Secrets 到 ${syncTarget}\n`));
      for (const key of newSecretKeys) {
        const value = envFileMap[key] || detectedEnvMap[key] || '';
        if (!value) {
          console.log(chalk.yellow(`  ⏭ ${key}: 值为空，跳过`));
          continue;
        }
        try {
          execSync(`gh secret set ${key} ${syncRepoFlag}`, {
            input: value, cwd: projectDir,
            stdio: ['pipe', 'ignore', 'pipe'],
          });
          console.log(chalk.green(`  ✔ ${key}`));
        } catch (err: any) {
          console.log(chalk.red(`  ✗ ${key}: ${err.message}`));
        }
      }
    }
  } else if (diff.added.some((k: string) => config.secrets.includes(k))) {
    const newSecretKeys = diff.added.filter((k: string) => config.secrets.includes(k));
    console.log(chalk.yellow('\n📌 以下新 Secrets 需要手动推送到 GitHub:'));
    for (const key of newSecretKeys) {
      console.log(chalk.yellow(`  gh secret set ${key}`));
    }
  }

  console.log(chalk.green.bold('\n✅ 环境变量同步完成\n'));
}

function printNextSteps(config: CollectedConfig): void {
  console.log(chalk.cyan.bold('\n📋 后续步骤:\n'));
  console.log('  1. 配置 GitHub Secrets:');
  console.log(chalk.gray('     deploy-setup setup-secrets'));
  console.log('  2. 初始化服务器:');
  console.log(chalk.gray('     deploy-setup setup-server'));
  console.log('  3. 推送代码触发部署:');
  console.log(chalk.gray(`     git add . && git commit -m "add CI/CD" && git push origin ${config.branches.production}`));
  console.log('');
  console.log(chalk.gray('  或者一键完成: deploy-setup all'));
}
