import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface SshConnection {
  host: string;
  user: string;
  sshKeyPath?: string;
  sshPort?: number | string;
}

export interface RunRemoteScriptOptions extends SshConnection {
  script: string;
  cwd?: string;
  timeoutMs?: number;
  tty?: boolean;
  label?: string;
}

export function resolveSshKeyPath(sshKeyPath?: string): string {
  return (sshKeyPath || '~/.ssh/id_ed25519').replace(/^~/, os.homedir());
}

export function normalizeSshPort(sshPort?: number | string): number {
  if (sshPort === undefined || sshPort === null || sshPort === '') {
    return 22;
  }

  const port = Number(sshPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`SSH 端口无效: ${sshPort}`);
  }
  return port;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildSshCommand(
  connection: SshConnection,
  remoteCommand: string,
  options: { connectTimeout?: number; tty?: boolean } = {},
): string {
  const connectTimeout = options.connectTimeout ?? 30;
  const resolvedKeyPath = resolveSshKeyPath(connection.sshKeyPath);
  const keyArg = fs.existsSync(resolvedKeyPath) ? ` -i ${shellQuote(resolvedKeyPath)}` : '';
  const ttyArg = options.tty ? ' -tt' : '';
  const port = normalizeSshPort(connection.sshPort);
  const target = `${connection.user}@${connection.host}`;

  return [
    'ssh',
    '-o StrictHostKeyChecking=no',
    `-o ConnectTimeout=${connectTimeout}`,
    `-p ${port}`,
    keyArg.trim(),
    ttyArg.trim(),
    shellQuote(target),
    shellQuote(remoteCommand),
  ].filter(Boolean).join(' ');
}

export function buildScpCommand(
  connection: SshConnection,
  sourcePath: string,
  remotePath: string,
  options: { connectTimeout?: number } = {},
): string {
  const connectTimeout = options.connectTimeout ?? 30;
  const resolvedKeyPath = resolveSshKeyPath(connection.sshKeyPath);
  const keyArg = fs.existsSync(resolvedKeyPath) ? ` -i ${shellQuote(resolvedKeyPath)}` : '';
  const port = normalizeSshPort(connection.sshPort);
  const target = `${connection.user}@${connection.host}:${remotePath}`;

  return [
    'scp',
    '-o StrictHostKeyChecking=no',
    `-o ConnectTimeout=${connectTimeout}`,
    `-P ${port}`,
    keyArg.trim(),
    shellQuote(sourcePath),
    shellQuote(target),
  ].filter(Boolean).join(' ');
}

export function runRemoteScript(options: RunRemoteScriptOptions): void {
  const timeoutMs = options.timeoutMs ?? 600000;
  const label = (options.label || 'deploy-setup').replace(/[^a-zA-Z0-9_.-]/g, '-');
  const script = options.script.replace(/\r\n/g, '\n');
  const connection: SshConnection = {
    host: options.host,
    user: options.user,
    sshKeyPath: options.sshKeyPath,
    sshPort: options.sshPort,
  };

  if (!options.tty) {
    const sshCmd = buildSshCommand(connection, 'bash -s', { connectTimeout: 30 });
    execSync(sshCmd, {
      input: script,
      cwd: options.cwd,
      stdio: ['pipe', 'inherit', 'inherit'],
      timeout: timeoutMs,
    });
    return;
  }

  const localScriptPath = path.join(os.tmpdir(), `${label}-${process.pid}-${Date.now()}.sh`);
  const remoteScriptPath = `/tmp/${path.basename(localScriptPath)}`;

  try {
    fs.writeFileSync(localScriptPath, script, 'utf-8');
    fs.chmodSync(localScriptPath, 0o600);
    const scpCmd = buildScpCommand(connection, localScriptPath, remoteScriptPath, { connectTimeout: 30 });
    execSync(scpCmd, {
      cwd: options.cwd,
      stdio: 'inherit',
      timeout: timeoutMs,
    });

    const remoteCommand = `bash ${remoteScriptPath}; status=$?; rm -f ${remoteScriptPath}; exit $status`;
    const sshCmd = buildSshCommand(connection, remoteCommand, { connectTimeout: 30, tty: true });
    execSync(sshCmd, {
      cwd: options.cwd,
      stdio: 'inherit',
      timeout: timeoutMs,
    });
  } finally {
    if (fs.existsSync(localScriptPath)) {
      fs.unlinkSync(localScriptPath);
    }
  }
}
