import { execSync } from 'node:child_process';
import * as fs from 'fs';
import * as os from 'os';
import { CollectedConfig } from './types';
import { readTemplate, replacePlaceholders } from '../utils/template';

export interface PatchServerOptions {
  config: CollectedConfig;
  projectDir?: string;
  keyPath?: string;
  dryRun?: boolean;
}

export function renderServerPatchScript(appName: string): string {
  return replacePlaceholders(readTemplate('scripts', 'server-patch.sh'), {
    PATCH_TARGET: appName || 'server',
  }).replace(/\r\n/g, '\n');
}

export function patchServer(options: PatchServerOptions): void {
  const { config, projectDir, dryRun } = options;
  const { host, user, sshKeyPath } = config.server;
  const resolvedKeyPath = (options.keyPath || sshKeyPath || '~/.ssh/id_rsa').replace(/^~/, os.homedir());
  const keyArg = fs.existsSync(resolvedKeyPath) ? `-i "${resolvedKeyPath}"` : '';
  const script = renderServerPatchScript(config.project?.name || 'server');

  if (dryRun) {
    process.stdout.write(script);
    return;
  }

  const sshCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 ${keyArg} ${user}@${host} "bash -s"`;
  execSync(sshCmd, {
    input: script,
    cwd: projectDir,
    stdio: ['pipe', 'inherit', 'inherit'],
    timeout: 1200000,
  });
}
