# Deploy 智能化重构文档

## 重构目标

解决 AI 无法执行交互式命令行工具的核心痛点，实现 AI 可完全自主完成部署。

## 核心改进

### 1. deploy-setup 工具改造

#### 新增 `detect` 命令

```bash
# 自动检测项目信息（JSON 输出）
deploy-setup detect --json

# 输出示例
{
  "type": "fastapi",
  "language": "python",
  "port": 8000,
  "startCmd": "uvicorn main:app --host 0.0.0.0 --port 8000",
  "envKeys": ["API_KEY", "DATABASE_URL"],
  "dbType": "postgres",
  "ormTool": "alembic"
}
```

**作用**：AI 可以自动获取项目信息，无需询问用户。

#### 强化非交互模式

- 保留 `-c config.json` 参数（配置文件优先）
- 不传 `-c` 时走默认交互式收集流程，传 `-c` 时跳过交互读取配置文件
- AI 始终使用 `-c` 模式，完全非交互

> 日常安装、使用、验证和维护说明见 `README.md`。本文主要保留智能化重构的设计背景。

### 2. Deploy Skill 重构

#### 智能依赖管理

```bash
# 自动检查 deploy-setup 是否存在
# 不存在时自动从 GitHub 克隆并安装
```

#### 智能配置收集流程

```
1. 检查 .deploy/config.json 是否存在
   ↓ 不存在
2. 执行 deploy-setup detect（自动检测项目）
   ↓
3. 加载 key-reader Skill（读取服务器配置）
   ↓
4. 检查未决项（域名、服务器选择）
   ↓
5. 最小化提问（只问真正缺失的信息）
   ↓
6. 生成 .deploy/config.json
   ↓
7. 执行 deploy-setup all -c .deploy/config.json
```

#### KeyReader 集成

**从 glo.env 读取服务器配置**：

```bash
# glo.env 格式
IP=47.98.171.82
USER_NAME=root
# 注意：仅支持 SSH 密钥认证，不支持密码认证
```

**AI 自动提取**：
- 服务器 IP
- SSH 用户名
- SSH 密钥路径（当前 CLI 默认优先使用 `~/.ssh/id_ed25519`，也会列出 `id_rsa`、`id_ecdsa`、硬件安全密钥等常见路径）

### 3. 配置优先级

```
1. 现有配置文件（.deploy/config.json）
2. 自动检测（deploy-setup detect）
3. KeyReader（glo.env）
4. 用户确认（AskUserQuestion）
```

**只有真正缺失的信息才问用户。**

## 工作流程对比

### 旧流程（AI 无法执行）

```
用户: "帮我部署"
AI: 执行 deploy-setup all
工具: 请输入服务器 IP？ ❌ AI 无法响应
工具: 请输入域名？ ❌ AI 无法响应
结果: 部署失败
```

### 新流程（AI 可完全自主）

```
用户: "帮我部署"

AI:
1. 检查 deploy-setup → 存在 ✓
2. 执行 detect → 检测到 FastAPI 项目 ✓
3. 加载 key-reader → 读取到服务器 47.98.171.82 ✓
4. 检查未决项 → 用户没提域名，需要确认
5. AskUserQuestion: "是否使用域名？"

用户: "否，用 IP"

AI:
6. 生成 .deploy/config.json ✓
7. 执行 deploy-setup all -c .deploy/config.json ✓
8. 部署成功 ✓
```

## 配置文件示例

### .deploy/config.json

`.deploy/config.json` 是本机可复用配置，当前仓库默认将其加入 `.gitignore`。如果需要给 AI 或团队复用，建议提供脱敏后的示例配置。

```json
{
  "project": {
    "name": "futures-monitor",
    "type": "fastapi",
    "language": "python",
    "port": 8000,
    "startCmd": "uvicorn main:app --host 0.0.0.0 --port 8000",
    "buildCmd": "",
    "projectStructure": "standard",
    "subDirs": {}
  },
  "server": {
    "host": "47.98.171.82",
    "user": "root",
    "sshKeyPath": "~/.ssh/id_ed25519",
    "sshPort": 22,
    "sudoMode": "none",
    "deployDir": "/opt/apps"
  },
  "domain": {
    "enabled": false,
    "name": "",
    "https": true
  },
  "secrets": ["API_KEY", "DATABASE_URL"],
  "envVars": {},
  "branches": {
    "production": "main",
    "staging": null
  },
  "database": {
    "type": "postgres",
    "location": "external",
    "dataDir": "",
    "initCmd": "",
    "migrateCmd": "alembic upgrade head",
    "createAdmin": false,
    "adminCmd": ""
  }
}
```

### 配置来源

| 字段 | 来源 | 方式 |
|------|------|------|
| `project.*` | deploy-setup detect | 自动检测 |
| `server.host` | KeyReader (glo.env) | 读取 IP |
| `server.user` | KeyReader (glo.env) | 读取 USER_NAME |
| `server.sshKeyPath` | 默认值 | ~/.ssh/id_ed25519 |
| `domain.*` | 用户确认 | AskUserQuestion |
| `secrets` | deploy-setup detect | 扫描 .env |

## 最小化提问策略

### 通常只需要问 1 个问题

**场景 1：用户提到了域名**
```
用户: "帮我部署到 example.com"
AI: 无需提问，直接部署 ✓
```

**场景 2：用户没提域名**
```
用户: "帮我部署"
AI: "是否使用域名访问？"
用户: "否"
AI: 部署完成 ✓
```

**场景 3：glo.env 有多个服务器**
```
AI: "部署到哪个服务器？"
    1) 47.98.171.82（阿里云杭州）
    2) 8.153.174.176（阿里云上海）
用户: "1"
AI: 部署完成 ✓
```

### 不需要问的问题

- ❌ 服务器 IP（从 KeyReader 读取）
- ❌ SSH 用户名（从 KeyReader 读取）
- ❌ 项目类型（自动检测）
- ❌ 端口号（自动检测）
- ❌ 启动命令（自动检测）
- ❌ 环境变量列表（自动扫描）

## 技术实现

### deploy-setup detect 命令

```typescript
// src/cli.ts
program
  .command('detect')
  .description('自动检测项目信息')
  .option('-d, --dir <dir>', '项目目录', process.cwd())
  .option('--json', '输出 JSON 格式')
  .action(async (options) => {
    const detection = detectProject(path.resolve(options.dir));
    if (options.json) {
      console.log(JSON.stringify(detection, null, 2));
    } else {
      // 人类可读格式
      console.log('项目类型:', detection.type);
      console.log('默认端口:', detection.port);
      // ...
    }
  });
```

### Deploy Skill 配置收集逻辑

```markdown
## 步骤2.2: 自动检测项目信息

```bash
$DEPLOY_CMD detect --json > /tmp/project-info.json
```

读取检测结果，获取：
- project.type
- project.port
- project.startCmd
- project.envKeys

## 步骤2.3: 从 KeyReader 读取服务器配置

```bash
python -X utf8 "~/.claude/plugins/.../key-reader/scripts/mask_read.py"
```

从输出中提取：
- IP（服务器地址）
- USER_NAME（SSH 用户）
```

## 测试验证

### 测试项目：futures_monitor

```bash
cd D:\TechWork\自由发散地\futures_monitor
node ../deploy-setup/dist/cli.js detect --json
```

**输出**：
```json
{
  "type": "fastapi",
  "language": "python",
  "port": 8000,
  "startCmd": "uvicorn main:app --host 0.0.0.0 --port 8000",
  "ormTool": "alembic"
}
```

✅ 自动检测成功

### KeyReader 测试

```bash
python -X utf8 "C:\Users\WaterFish\.claude\plugins\cache\cytopia-marketplace\workflow-kit\2.4.3\skills\key-reader\scripts\mask_read.py"
```

**输出**：
```
IP=47.98.171.82
USER_NAME=root
# 注意：仅支持 SSH 密钥认证，不支持密码认证
```

✅ 服务器配置读取成功

## 部署流程示例

### 完整对话示例

```
用户: "帮我部署 futures_monitor 项目"

AI:
1. 检查 deploy-setup... ✓ 已安装
2. 检测项目信息... ✓ FastAPI, 端口 8000
3. 读取服务器配置... ✓ 47.98.171.82, root
4. 检查未决项... 需要确认域名

AI: "是否使用域名访问？"
    1) 是（需要提供域名）
    2) 否（使用 IP 访问）

用户: "2"

AI:
5. 生成配置文件... ✓ .deploy/config.json
6. 执行部署... ✓ deploy-setup all -c .deploy/config.json
7. 部署成功！访问地址: http://47.98.171.82:8000
```

## 优势总结

### 1. AI 可完全自主执行
- 无需人类介入交互式命令
- 所有交互通过 AskUserQuestion（AI 可控）

### 2. 最小化用户负担
- 通常只需回答 1 个问题（域名）
- 其他信息全部自动获取

### 3. 配置可复用
- 首次部署生成 .deploy/config.json
- 后续部署直接使用，无需重新配置

### 4. 流程可追溯
- 真实 `.deploy/config.json` 留在本机；需要追溯或团队复用时提交脱敏示例配置
- 部署过程可复现

### 5. 错误可恢复
- 配置错误可编辑 .deploy/config.json
- 部署失败可重试

## 未来改进

### 短期
- [ ] 支持多环境配置（production / staging）
- [ ] 自动识别 glo.env 中的多服务器注释
- [ ] 域名自动从 glo.env 的 PERSONAL_DOMAIN_NAME 读取

### 中期
- [ ] 实现配置模板生成 `deploy-setup init --template-only`
- [ ] 实现配置管理命令 `config show/edit/validate`
- [ ] 支持环境变量替换 `${VAR}`

### 长期
- [ ] 将 deploy-setup 改造为 MCP Server
- [ ] Deploy Skill 通过 MCP 协议调用
- [ ] 实现部署状态实时监控

## 总结

**核心突破**：将"交互"从工具层提升到 Skill 层。

- **工具层**：纯执行，完全非交互
- **Skill 层**：智能收集配置，最小化提问
- **结果**：AI 可完全自主完成部署

**用户体验**：
- 理想情况：0 个问题（用户提到了域名）
- 常见情况：1 个问题（是否使用域名）
- 最坏情况：2 个问题（域名 + 服务器选择）

**技术实现**：
- deploy-setup detect：自动检测项目
- KeyReader：读取服务器配置
- AskUserQuestion：最小化提问
- config.json：配置文件优先

这次重构彻底解决了 AI 无法执行交互式工具的痛点。
