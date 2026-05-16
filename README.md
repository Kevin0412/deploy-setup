# deploy-setup

通用 CI/CD 配置生成工具，用于把常见 Web 项目部署到 Linux VPS。它会检测项目类型，生成 Docker、docker-compose、GitHub Actions 和服务器初始化脚本，并提供 DNS 检查、GitHub Secrets 配置、环境变量同步和重新部署命令。

## 能做什么

- 自动检测 Flask、Django、FastAPI、NestJS、Next.js、Nuxt、Vue SPA、React SPA 等项目。
- 生成 `Dockerfile`、`.dockerignore`、`docker-compose.yml`、`.github/workflows/deploy.yml`、`server-init.sh`。
- 根据服务器探测结果选择部署策略：服务器构建，或 CI 构建后 SCP 到服务器。
- 支持 proxy repo 模式，把真正执行部署或发布的 workflow 推到 `{repo}-releases` 仓库。
- 支持 `.env` 变量扫描、Secrets 分类、`sync-env` 增量同步。
- 提供 `redeploy` 触发 `workflow_dispatch`，用于代码不变时重新部署。
- `server-init.sh` 会在服务器初始化时自动应用安全更新，并对近期 Linux 本地提权漏洞启用内核模块缓解。

## 快速开始

```bash
npm ci
npm run build
node dist/cli.js detect --json -d /path/to/project
```

交互式初始化：

```bash
node dist/cli.js init -d /path/to/project
```

`init` 会在服务器配置阶段依次询问服务器地址、SSH 用户、SSH 端口和私钥路径。私钥路径会优先列出常见文件：`~/.ssh/id_ed25519`、`~/.ssh/id_rsa`、`~/.ssh/id_ecdsa`、`~/.ssh/id_ed25519_sk`、`~/.ssh/id_ecdsa_sk`，最后提供手动输入其他路径。随后会先选择下一步操作：暂不执行、初始化服务器，或只对已部署服务器运行 `patch-server` 安全补丁；只有初始化服务器/部署前准备路径会继续询问部署目录。

如果选择“已部署服务器：只打安全补丁”，`init` 会走补丁短路径，不再询问项目类型、域名、Secrets、部署分支或部署目录，也不会生成 Docker/Workflow 文件。

使用配置文件初始化：

```bash
node dist/cli.js init -d /path/to/project -c /path/to/project/.deploy/config.json
```

一键执行初始化、DNS 检查、服务器初始化、Secrets 配置和推送验证：

```bash
node dist/cli.js all -d /path/to/project -c /path/to/project/.deploy/config.json
```

`all --unattended` 只跳过最后的 `git push`，仍会执行服务器初始化和 Secrets 配置。业务 Secrets 可以用 `--env-file` 注入，SSH 私钥可以用 `--key` 指定。

## 验证

本仓库提供一条完整本地验证命令：

```bash
npm run verify
```

它会依次执行：

- `npm run build`
- `npm test`
- `node dist/cli.js --version`
- `node dist/cli.js detect --json -d .`

当前测试覆盖场景识别、proxy workflow 模板、JSON 输出、重新部署命令、legacy workflow 生成和 `.deploy/config.json` 写入。

有 Podman 或 Docker 权限的机器还可以跑容器级验证。该命令不使用 `sudo`，默认优先使用 Podman，缺失时回退到 Docker：

```bash
npm run verify:container
```

容器验证会启动 Ubuntu 容器，执行渲染后的 `server-patch.sh`。为了避免真实修改容器系统包，`apt-get`、`systemctl`、`rmmod` 等破坏性命令会被 stub，但会检查补丁脚本流程、自动更新配置和本地提权模块屏蔽文件是否真实写入。

可以通过环境变量指定运行时或镜像：

```bash
CONTAINER_RUNTIME=podman npm run verify:container
VERIFY_CONTAINER_IMAGE=docker.io/library/ubuntu:24.04 npm run verify:container
```

## 常用命令

```bash
# 检测项目
node dist/cli.js detect --json -d .

# 生成部署配置和模板文件
node dist/cli.js init -d . -c .deploy/config.json

# 检查域名 DNS 是否指向服务器
node dist/cli.js check-dns -d .

# SSH 到服务器执行 server-init.sh
node dist/cli.js setup-server -d .
node dist/cli.js setup-server -d . --port 2222 --key ~/.ssh/id_ed25519

# 对已部署完成的服务器单独应用安全补丁，不重新初始化或部署
node dist/cli.js patch-server -d .
node dist/cli.js patch-server -d . --port 2222 --key ~/.ssh/id_ed25519
node dist/cli.js patch-server -d . --dry-run

# 配置 GitHub Secrets
node dist/cli.js setup-secrets -d . --key ~/.ssh/id_ed25519 --port 2222 --env-file .env

# 同步新增或删除的 .env 变量
node dist/cli.js sync-env -d . --dry-run
node dist/cli.js sync-env -d . --yes --push-secrets --env-file .env

# 重新触发部署 workflow
node dist/cli.js redeploy -c .deploy/config.json
```

## 配置文件

`init` 会保存两份配置：

- `.deploy/config.json`：可复用部署配置，适合作为 `-c` 输入，也供 `redeploy` 默认读取。
- `.deploy-setup-cache.json`：CLI 内部缓存，供 `probe`、`setup-server`、`setup-secrets`、`sync-env` 等命令读取。

最小配置示例：

```json
{
  "project": {
    "name": "demo-api",
    "type": "fastapi",
    "language": "python",
    "port": 8000,
    "buildCmd": "",
    "startCmd": "uvicorn main:app --host 0.0.0.0 --port 8000",
    "projectStructure": "standard",
    "subDirs": {}
  },
  "server": {
    "host": "203.0.113.10",
    "user": "deploy",
    "sshKeyPath": "~/.ssh/id_ed25519",
    "sshPort": 22,
    "sudoMode": "tty",
    "deployDir": "/opt/apps"
  },
  "domain": {
    "enabled": false,
    "name": "",
    "https": false
  },
  "secrets": ["API_KEY"],
  "envVars": {
    "NODE_ENV": "production"
  },
  "branches": {
    "production": "main",
    "staging": null
  },
  "postInitAction": "setup-server",
  "database": {
    "type": "none",
    "location": "none",
    "dataDir": "",
    "initCmd": "",
    "migrateCmd": "",
    "createAdmin": false,
    "adminCmd": ""
  }
}
```

## 生成文件

`init` 可能会写入或覆盖这些文件，覆盖前会生成 `.backup`：

- `Dockerfile`
- `.dockerignore`
- `docker-compose.yml`
- `.github/workflows/deploy.yml`
- `.github/workflows/release.yml`，proxy repo 模式下的触发 workflow
- `nginx.conf`，仅 SPA 项目需要
- `server-init.sh`
- `.gitattributes`

## Proxy Repo 模式

默认启用 proxy repo 模式。项目仓库只保留触发 workflow，真正部署或发布的 workflow 会推送到 `{当前仓库名}-releases`。

需要准备：

- 项目仓库：`GH_RELEASE_REPO_TOKEN`，用于触发 proxy repo 的 `repository_dispatch`。
- Proxy repo：`SERVER_HOST`、`SERVER_USER`、`SERVER_PORT`、`SSH_PRIVATE_KEY` 和业务 Secrets。

如果想把完整部署 workflow 直接生成到当前仓库，使用 legacy 模式：

```bash
node dist/cli.js init -d . -c .deploy/config.json --legacy
```

## 安全更新

`setup-server` 和 `all` 都会运行生成的 `server-init.sh`。脚本开头会做一轮幂等安全处理。

已经部署完成的服务器可以单独运行补丁命令，不会重跑 Docker、端口、Nginx 站点或 HTTPS 初始化：

```bash
node dist/cli.js patch-server -d .
node dist/cli.js patch-server -d . -c .deploy/config.json
node dist/cli.js patch-server -d . --dry-run
```

如果 SSH 用户不是 `root`，`init` 可以选择 `sudoMode: "tty"`。此模式会用 `ssh -tt` 打开远程终端，`sudo` 密码只通过 SSH 加密通道输入到远程服务器，不写入 `.deploy/config.json`、缓存文件或 GitHub Secrets。CI/CD 的非交互部署仍建议使用 root、免密 sudo，或让部署用户加入 docker 组。

为避免 SSH 登录密码在部分终端中回显，CLI 不会回退到 SSH 密码登录；私钥文件不存在时会直接报错。请使用存在的 SSH 私钥，或先把私钥放到对应路径。

补丁脚本会执行：

- 对 Debian/Ubuntu 服务器执行 `apt-get update`、安装 `unattended-upgrades`、执行非交互式 `apt-get upgrade`。
- 如果宿主机已安装 Nginx，会在升级后尝试重启 Nginx，让修复后的包生效。
- 写入 `/etc/apt/apt.conf.d/20auto-upgrades`，开启每日自动安全更新。
- 写入 `/etc/modprobe.d/deploy-setup-local-lpe.conf`，阻止 `algif_aead`、`esp4`、`esp6`、`rxrpc` 这些近期 Linux 本地提权漏洞涉及的攻击面模块再次加载。
- 尝试卸载已经加载的相关模块；如果模块仍在使用，会提示重启服务器后完全生效。

这些缓解覆盖的是当前已公开、可通过系统包升级或模块屏蔽处理的漏洞类型。内核升级通常需要重启才会真正切换到新内核；如果你的服务器依赖 IPsec、AFS/RXRPC 或相关内核模块，需要先评估模块屏蔽对业务的影响。

SPA 项目生成的运行时镜像固定为 `nginx:1.30.1-alpine`，避免继续使用漂移的 `nginx:alpine`。

## 项目结构

```text
src/cli.ts                 CLI 命令入口
src/core/detector.ts       项目类型、环境变量、场景检测
src/core/collector.ts      交互式配置收集
src/core/generator.ts      模板渲染与文件写入
src/core/patcher.ts        已部署服务器安全补丁
src/core/strategy.ts       部署策略与 proxy repo 配置
src/core/prober.ts         服务器能力探测
src/core/env-sync.ts       .env 差异和 workflow patch
src/core/redeployer.ts     workflow_dispatch 重新部署
src/templates/             Docker、Compose、Workflow、脚本模板
tests/                     Vitest 测试
```

## 部署前置条件

- 本地安装 Node.js 和 npm。
- 目标项目是 GitHub 仓库，并可用 `gh` 访问。
- 本地可通过 SSH key 登录目标服务器。
- 目标服务器是 Linux，支持 Docker 和 Docker Compose；`server-init.sh` 会尝试自动安装缺失组件。
- 使用 HTTPS 域名时，域名 DNS 需要先指向服务器 IP。

## 维护提示

- 改模板后运行 `npm run verify`，确认模板能被复制到 `dist/templates` 并通过测试。
- 改 CLI 命令或输出时，优先补测试，尤其是 JSON 输出和非交互路径。
- 涉及真实 GitHub、SSH、DNS 的命令属于集成路径，本地 `verify` 只覆盖可离线验证的部分。
