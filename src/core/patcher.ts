import { CollectedConfig } from './types';
import { readTemplate, replacePlaceholders } from '../utils/template';
import { runRemoteScript } from '../utils/ssh-runner';

export interface PatchServerOptions {
  config: CollectedConfig;
  projectDir?: string;
  keyPath?: string;
  sshPort?: number | string;
  dryRun?: boolean;
}

export function renderServerPatchScript(appName: string): string {
  return replacePlaceholders(readTemplate('scripts', 'server-patch.sh'), {
    PATCH_TARGET: appName || 'server',
  }).replace(/\r\n/g, '\n');
}

export function patchServer(options: PatchServerOptions): void {
  const { config, projectDir, dryRun } = options;
  const script = renderServerPatchScript(config.project?.name || 'server');

  if (dryRun) {
    process.stdout.write(script);
    return;
  }

  runRemoteScript({
    host: config.server.host,
    user: config.server.user,
    sshKeyPath: options.keyPath || config.server.sshKeyPath,
    sshPort: options.sshPort || config.server.sshPort,
    script,
    cwd: projectDir,
    timeoutMs: 1200000,
    tty: config.server.sudoMode === 'tty',
    label: 'server-patch',
  });
}
