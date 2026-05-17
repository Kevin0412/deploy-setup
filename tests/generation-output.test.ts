import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { generateFiles } from '../src/core/generator'
import { saveDeployConfig } from '../src/utils/cache'
import type { CollectedConfig } from '../src/core/types'

function baseConfig(overrides: Partial<CollectedConfig> = {}): CollectedConfig {
  const config: CollectedConfig = {
    project: {
      name: 'demo-app',
      type: 'fastapi',
      language: 'python',
      port: 8000,
      buildCmd: '',
      startCmd: 'uvicorn main:app --host 0.0.0.0 --port 8000',
      projectStructure: 'standard',
      subDirs: {},
    },
    server: {
      host: '127.0.0.1',
      user: 'root',
      sshKeyPath: '~/.ssh/id_rsa',
      deployDir: '/opt/apps',
    },
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
    proxyRepo: {
      enabled: false,
      owner: '',
      repo: '',
      eventType: '',
      checkoutTokenSecret: '',
    },
    database: {
      type: 'none',
      location: 'none',
      dataDir: '',
      initCmd: '',
      migrateCmd: '',
      createAdmin: false,
      adminCmd: '',
    },
  }

  return { ...config, ...overrides }
}

describe('generated deployment output', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-setup-generation-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('includes build and up commands in legacy generated workflow', () => {
    generateFiles(baseConfig(), tmpDir)

    const workflow = fs.readFileSync(path.join(tmpDir, '.github', 'workflows', 'deploy.yml'), 'utf-8')

    expect(workflow).toContain('docker compose build')
    expect(workflow).toContain('docker compose up -d --remove-orphans')
    expect(workflow).toContain("port: ${{ secrets.SERVER_PORT || '22' }}")
    expect(workflow).toContain('[ "$STATUS" -lt 400 ]')
    expect(workflow).not.toContain('[ "$STATUS" -lt 500 ]')
    expect(workflow).not.toContain('Using existing docker-compose.yml, skip build')
    expect(workflow).not.toContain('{{#IF NOT_SKIP_BUILD}}')
  })

  it('generates server security mitigations for recent nginx and Linux LPE issues', () => {
    generateFiles(baseConfig(), tmpDir)

    const serverInit = fs.readFileSync(path.join(tmpDir, 'server-init.sh'), 'utf-8')
    const dockerfile = fs.readFileSync(path.join(tmpDir, 'Dockerfile'), 'utf-8')

    expect(serverInit).toContain('unattended-upgrades')
    expect(serverInit).toContain('apt_command_with_mirror_retry "系统安全升级" upgrade ${APT_OPTS}')
    expect(serverInit).toContain('--fix-missing')
    expect(serverInit).toContain('as_root env DEBIAN_FRONTEND=noninteractive')
    expect(serverInit).toContain('sudo tee "$target" >/dev/null')
    expect(serverInit).toContain('install algif_aead /bin/false')
    expect(serverInit).toContain('install esp4 /bin/false')
    expect(serverInit).toContain('install esp6 /bin/false')
    expect(serverInit).toContain('install rxrpc /bin/false')
    expect(dockerfile).not.toContain('FROM nginx:')
  })

  it('writes generated .env values without shell echo injection', () => {
    generateFiles(baseConfig({
      secrets: ['API_TOKEN'],
      envVars: {
        NODE_ENV: 'production',
        CALLBACK: '$(touch /tmp/deploy-setup-pwned)',
      },
    }), tmpDir)

    const workflow = fs.readFileSync(path.join(tmpDir, '.github', 'workflows', 'deploy.yml'), 'utf-8')

    expect(workflow).toContain("cat > .env << 'ENVEOF'")
    expect(workflow).toContain('CALLBACK=$(touch /tmp/deploy-setup-pwned)')
    expect(workflow).toContain('API_TOKEN=${{ secrets.API_TOKEN }}')
    expect(workflow).not.toContain('echo "CALLBACK=')
    expect(workflow).not.toContain('echo "API_TOKEN=')
  })

  it('pins SPA nginx runtime image to a fixed security line', () => {
    generateFiles(baseConfig({
      project: {
        name: 'demo-spa',
        type: 'react-spa',
        language: 'node',
        port: 8080,
        buildCmd: 'npm run build',
        startCmd: '',
        projectStructure: 'standard',
        subDirs: {},
      },
    }), tmpDir)

    const dockerfile = fs.readFileSync(path.join(tmpDir, 'Dockerfile'), 'utf-8')

    expect(dockerfile).toContain('FROM nginx:1.30.1-alpine AS production')
    expect(dockerfile).not.toContain('FROM nginx:alpine')
  })

  it('keeps .deploy/ out of the runtime docker image', () => {
    generateFiles(baseConfig(), tmpDir)

    const dockerignore = fs.readFileSync(path.join(tmpDir, '.dockerignore'), 'utf-8')

    expect(dockerignore.split(/\r?\n/)).toContain('.deploy/')
    expect(dockerignore.split(/\r?\n/)).toContain('.deploy-setup-cache.json')
  })

  it('seeds .gitignore with deploy-setup private state when missing', () => {
    generateFiles(baseConfig(), tmpDir)

    const gitignorePath = path.join(tmpDir, '.gitignore')
    expect(fs.existsSync(gitignorePath)).toBe(true)
    const lines = fs.readFileSync(gitignorePath, 'utf-8').split(/\r?\n/)
    expect(lines).toContain('.deploy/')
    expect(lines).toContain('.deploy-setup-cache.json')
  })

  it('appends only missing entries to an existing .gitignore', () => {
    const existing = 'node_modules/\n.deploy/\n'
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), existing, 'utf-8')

    generateFiles(baseConfig(), tmpDir)

    const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8')
    expect(content).toContain('node_modules/')
    expect(content).toContain('.deploy/')
    expect(content).toContain('.deploy-setup-cache.json')
    expect(content.match(/^\.deploy\/$/gm)?.length).toBe(1)
  })

  it('writes reusable deploy config to .deploy/config.json', () => {
    const config = baseConfig()

    saveDeployConfig(tmpDir, config)

    const savedPath = path.join(tmpDir, '.deploy', 'config.json')
    expect(fs.existsSync(savedPath)).toBe(true)
    expect(fs.statSync(savedPath).mode & 0o777).toBe(0o600)
    expect(JSON.parse(fs.readFileSync(savedPath, 'utf-8')).project.name).toBe('demo-app')
  })
})
