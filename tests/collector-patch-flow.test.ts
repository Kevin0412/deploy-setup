import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import inquirer from 'inquirer'
import { collectConfig } from '../src/core/collector'
import type { DetectionResult } from '../src/core/types'

vi.mock('inquirer', () => ({
  default: {
    prompt: vi.fn(),
  },
}))

function detection(): DetectionResult {
  return {
    type: null,
    language: 'node',
    languageVersion: '20',
    port: 3000,
    buildCmd: '',
    startCmd: '',
    entryFile: '',
    envFile: null,
    envKeys: [],
    envPairs: {},
    hasDocker: false,
    hasCI: false,
    dataDir: '',
    dbType: 'none',
    ormTool: 'none',
    projectStructure: 'standard',
    subDirs: {},
    nativeModules: [],
    scenario: 'simple-web',
  }
}

describe('collector patch-only flow', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-setup-config-'))
    process.env.DEPLOY_SETUP_CONFIG_DIR = tmpDir
    vi.clearAllMocks()
  })

  afterEach(() => {
    delete process.env.DEPLOY_SETUP_CONFIG_DIR
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('skips deployment prompts when patch-server is selected', async () => {
    vi.mocked(inquirer.prompt).mockImplementation(async (questions: any) => {
      const names = (Array.isArray(questions) ? questions : [questions]).map((q: any) => q.name)
      if (names.includes('host')) {
        return { host: '203.0.113.10', user: 'root', sshPort: 22 }
      }
      if (names.includes('sshKeyChoice')) {
        return { sshKeyChoice: '~/.ssh/id_ed25519' }
      }
      if (names.includes('postInitAction')) {
        return { postInitAction: 'patch-server' }
      }
      if (names.includes('saveName')) {
        return { saveName: 'prod' }
      }
      if (names.includes('action')) {
        return { action: 'confirm' }
      }
      throw new Error(`Unexpected prompt: ${names.join(',')}`)
    })

    const config = await collectConfig(detection(), 'demo-app')

    const promptedNames = vi.mocked(inquirer.prompt).mock.calls
      .flatMap(([questions]) => (Array.isArray(questions) ? questions : [questions]).map((q: any) => q.name))

    expect(config.postInitAction).toBe('patch-server')
    expect(config.server.deployDir).toBe('/opt/apps')
    expect(promptedNames).not.toContain('deployDir')
    expect(promptedNames).not.toContain('type')
    expect(promptedNames).not.toContain('enabled')
    expect(promptedNames).not.toContain('production')
  })
})
