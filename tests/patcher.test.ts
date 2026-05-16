import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as childProcess from 'node:child_process'
import { loadDeployConfig, saveCache, saveDeployConfig } from '../src/utils/cache'
import { patchServer, renderServerPatchScript } from '../src/core/patcher'
import type { CollectedConfig } from '../src/core/types'

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}))

function baseConfig(): CollectedConfig {
  return {
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
      host: '203.0.113.10',
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
}

describe('server patching', () => {
  let tmpDir: string
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patcher-test-'))
    vi.clearAllMocks()
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('renders a standalone security patch script', () => {
    const script = renderServerPatchScript('demo-app')

    expect(script).toContain('PATCH_TARGET="demo-app"')
    expect(script).toContain('deploy-setup 服务器补丁: ${PATCH_TARGET}')
    expect(script).toContain('as_root env DEBIAN_FRONTEND=noninteractive')
    expect(script).toContain('apt_command_with_mirror_retry "系统安全升级" upgrade ${APT_OPTS}')
    expect(script).toContain('refresh_apt_indexes_for_retry')
    expect(script).toContain('--fix-missing')
    expect(script).toContain('请稍后重跑 patch-server 或更换镜像源')
    expect(script).toContain('请检查是否有异常提权的情况')
    expect(script).toContain('sudo tee "$target" >/dev/null')
    expect(script).toContain('install algif_aead /bin/false')
    expect(script).toContain('install rxrpc /bin/false')
    expect(script).not.toContain('{{PATCH_TARGET}}')
  })

  it('prints the patch script without ssh in dry-run mode', () => {
    patchServer({ config: baseConfig(), projectDir: tmpDir, dryRun: true })

    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('PATCH_TARGET="demo-app"'))
    expect(childProcess.execSync).not.toHaveBeenCalled()
  })

  it('runs patch script over ssh using stdin', () => {
    const config = baseConfig()
    config.server.sshKeyPath = path.join(tmpDir, 'id_ed25519')
    fs.writeFileSync(config.server.sshKeyPath, 'fake-key')

    patchServer({ config, projectDir: tmpDir })

    expect(childProcess.execSync).toHaveBeenCalledWith(
      expect.stringContaining('ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=30 -p 22'),
      expect.objectContaining({
        cwd: tmpDir,
        input: expect.stringContaining('PATCH_TARGET="demo-app"'),
        timeout: 1200000,
      }),
    )
    expect(childProcess.execSync).toHaveBeenCalledWith(
      expect.stringContaining("'root@203.0.113.10' 'bash -s'"),
      expect.anything(),
    )
  })

  it('uses an SSH TTY for sudo-capable patching without storing a password', () => {
    const config = baseConfig()
    config.server.user = 'deploy'
    config.server.sshKeyPath = path.join(tmpDir, 'id_ed25519')
    fs.writeFileSync(config.server.sshKeyPath, 'fake-key')
    config.server.sshPort = 2202
    config.server.sudoMode = 'tty'

    patchServer({ config, projectDir: tmpDir })

    const calls = vi.mocked(childProcess.execSync).mock.calls
    expect(calls[0][0]).toEqual(expect.stringContaining('scp '))
    expect(calls[0][0]).toEqual(expect.stringContaining('-P 2202'))
    expect(calls[1][0]).toEqual(expect.stringContaining('ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=30 -p 2202'))
    expect(calls[1][0]).toEqual(expect.stringContaining('-tt'))
    expect(calls[1][0]).toEqual(expect.stringContaining("'deploy@203.0.113.10'"))
    expect(calls[1][1]).toEqual(expect.objectContaining({ stdio: 'inherit' }))
    expect(JSON.stringify(config.server)).not.toMatch(/password/i)
  })

  it('fails instead of falling back to SSH password auth when key is missing', () => {
    const config = baseConfig()
    config.server.sshKeyPath = path.join(tmpDir, 'missing-key')

    expect(() => patchServer({ config, projectDir: tmpDir })).toThrow('SSH 私钥文件不存在')
    expect(childProcess.execSync).not.toHaveBeenCalled()
  })

  it('loads .deploy/config.json before falling back to the cache', () => {
    const cached = baseConfig()
    cached.project.name = 'cached-app'
    const deployConfig = baseConfig()
    deployConfig.project.name = 'deploy-config-app'

    saveCache(tmpDir, cached)
    saveDeployConfig(tmpDir, deployConfig)

    expect(loadDeployConfig(tmpDir).project.name).toBe('deploy-config-app')
  })

  it('falls back to .deploy-setup-cache.json when deploy config is missing', () => {
    const cached = baseConfig()
    cached.project.name = 'cached-app'
    saveCache(tmpDir, cached)

    expect(loadDeployConfig(tmpDir).project.name).toBe('cached-app')
  })
})
