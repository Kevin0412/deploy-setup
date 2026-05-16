/**
 * SSH-based deployment lock.
 *
 * Acquires an atomic mkdir-style lock directory on the target server.
 * Prevents two concurrent `deploy-setup` invocations (from different
 * machines or parallel agents) from racing each other on the same
 * target server — which can corrupt docker image loads, .env writes,
 * or compose restarts.
 *
 * Lock directory convention: /tmp/deploy-setup-lock-{project}/
 * Contains an `owner` file with holder hint + UTC timestamp.
 *
 * Stale detection: locks older than staleSeconds (default 1800s = 30min)
 * are auto-released with a warning. A deploy that legitimately runs
 * longer than 30min should pass a larger staleSeconds.
 */
import { execSync } from 'child_process';
import { buildSshCommand } from './ssh-runner';

export interface ServerLockOptions {
  host: string;
  user: string;
  sshKeyPath: string;
  sshPort?: number;
  projectName: string;
  holderHint: string;
  staleSeconds?: number;
}

export interface ServerLockHandle {
  release: () => void;
}

function sshExec(
  host: string,
  user: string,
  keyPath: string,
  sshPort: number | undefined,
  script: string,
  timeoutMs = 30000,
): { stdout: string; code: number } {
  const cmd = buildSshCommand(
    { host, user, sshKeyPath: keyPath, sshPort },
    'bash -s',
    { connectTimeout: 15 },
  );
  try {
    const stdout = execSync(cmd, {
      input: script,
      timeout: timeoutMs,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, code: 0 };
  } catch (err: any) {
    return {
      stdout: (err.stdout || '').toString() + (err.stderr || '').toString(),
      code: err.status ?? 1,
    };
  }
}

/**
 * Acquire a server-side lock. Throws if held and not stale.
 * Returns a handle with a synchronous `release()` method that should
 * be called in finally blocks.
 */
export function acquireServerLock(opts: ServerLockOptions): ServerLockHandle {
  const { host, user, sshKeyPath, sshPort, projectName, holderHint } = opts;
  const staleSeconds = opts.staleSeconds ?? 1800;
  const lockDir = `/tmp/deploy-setup-lock-${projectName}`;
  const now = new Date().toISOString();

  const acquireScript = `
set -e
LOCK_DIR="${lockDir}"
HOLDER="${holderHint.replace(/"/g, '\\"')}"
STAMP="${now}"
STALE=${staleSeconds}

if mkdir "$LOCK_DIR" 2>/dev/null; then
  printf '%s\\n%s\\n' "$HOLDER" "$STAMP" > "$LOCK_DIR/owner"
  echo "ACQUIRED"
  exit 0
fi

# Lock exists — inspect staleness via directory mtime
if [ ! -d "$LOCK_DIR" ]; then
  echo "RACE_LOST"  # directory vanished between our mkdir check and stat
  exit 1
fi

AGE=$(( $(date +%s) - $(stat -c %Y "$LOCK_DIR" 2>/dev/null || echo 0) ))
OWNER_LINE=$(head -1 "$LOCK_DIR/owner" 2>/dev/null || echo "unknown")
STAMP_LINE=$(sed -n '2p' "$LOCK_DIR/owner" 2>/dev/null || echo "unknown")

if [ "$AGE" -gt "$STALE" ]; then
  echo "STALE:$OWNER_LINE:$STAMP_LINE:\${AGE}s"
  exit 2
fi

echo "HELD:$OWNER_LINE:$STAMP_LINE:\${AGE}s"
exit 3
`;

  const result = sshExec(host, user, sshKeyPath, sshPort, acquireScript);
  const firstLine = result.stdout.trim().split('\n').pop() || '';

  if (firstLine === 'ACQUIRED') {
    return {
      release: () => {
        sshExec(host, user, sshKeyPath, sshPort, `rm -rf "${lockDir}"`);
      },
    };
  }

  if (firstLine.startsWith('STALE:')) {
    const [, owner, stamp, age] = firstLine.split(':');
    throw new Error(
      `Deploy lock on ${host} is stale (owner=${owner}, stamp=${stamp}, age=${age}). ` +
        `Run: ssh ${user}@${host} "rm -rf ${lockDir}" and retry.`,
    );
  }

  if (firstLine.startsWith('HELD:')) {
    const [, owner, stamp, age] = firstLine.split(':');
    throw new Error(
      `Deploy lock on ${host} is held by another run (owner=${owner}, stamp=${stamp}, age=${age}). ` +
        `Wait for it to finish, or if you're certain it's dead: ssh ${user}@${host} "rm -rf ${lockDir}"`,
    );
  }

  throw new Error(
    `Failed to acquire deploy lock on ${host} (exit=${result.code}): ${result.stdout.slice(-200)}`,
  );
}

/**
 * Force-release a lock. Use only when user has confirmed the holder is dead.
 */
export function forceReleaseServerLock(opts: Omit<ServerLockOptions, 'holderHint'>): void {
  const { host, user, sshKeyPath, sshPort, projectName } = opts;
  const lockDir = `/tmp/deploy-setup-lock-${projectName}`;
  sshExec(host, user, sshKeyPath, sshPort, `rm -rf "${lockDir}"`);
}
