import { execSync } from 'child_process';
import { ServerConfig, ProbeResult } from './types';
import { buildSshCommand } from '../utils/ssh-runner';

/**
 * Check if GitHub API is reachable from the local machine.
 * Used to decide whether proxy repo mode is viable.
 */
export function probeGitHubApi(): boolean {
  try {
    execSync('curl -sSL --connect-timeout 5 https://api.github.com', {
      stdio: 'ignore',
      timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * SSH to the server and probe its capabilities.
 * Returns a ProbeResult describing hardware, software, and network conditions.
 */
export function probeServer(server: ServerConfig): ProbeResult {
  const script = `
    echo "===MEMORY==="
    free -m 2>/dev/null | awk '/Mem:/{print $2}' || echo "0"
    echo "===CPU==="
    nproc 2>/dev/null || echo "1"
    echo "===DISK==="
    df -BG / 2>/dev/null | tail -1 | awk '{gsub("G",""); print $4}' || echo "0"
    echo "===DOCKER==="
    command -v docker &>/dev/null && echo "yes" || echo "no"
    echo "===COMPOSE==="
    docker compose version &>/dev/null && echo "yes" || echo "no"
    echo "===DOCKERHUB==="
    curl -s --connect-timeout 5 https://registry-1.docker.io/v2/ &>/dev/null && echo "reachable" || echo "blocked"
    echo "===NPM==="
    curl -s --connect-timeout 5 https://registry.npmjs.org/ &>/dev/null && echo "reachable" || echo "blocked"
    echo "===ALPINE==="
    curl -s --connect-timeout 5 https://dl-cdn.alpinelinux.org/alpine/ &>/dev/null && echo "reachable" || echo "blocked"
    echo "===GEO==="
    curl -s --connect-timeout 5 ipinfo.io/country 2>/dev/null || echo "UNKNOWN"
    echo "===GITHUBAPI==="
    curl -s --connect-timeout 5 https://api.github.com &>/dev/null && echo "reachable" || echo "blocked"
  `.trim();

  let output: string;
  try {
    output = execSync(buildSshCommand(server, 'bash -s', { connectTimeout: 15 }), {
      input: script,
      encoding: 'utf-8',
      timeout: 60000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    // If SSH fails, return conservative defaults
    console.warn(`Server probe failed: ${err.message}. Using conservative defaults.`);
    return {
      memoryMB: 0,
      cpuCores: 1,
      diskFreeGB: 0,
      dockerInstalled: false,
      dockerComposeInstalled: false,
      dockerHubReachable: false,
      npmReachable: false,
      alpineReachable: false,
      geoCountry: 'UNKNOWN',
      githubApiReachable: false,
      needsChinaMirrors: false,
    };
  }

  const getSection = (name: string): string => {
    const regex = new RegExp(`===${name}===\\s*([^=]*?)(?:===|$)`);
    const match = output.match(regex);
    return match ? match[1].trim() : '';
  };

  const geo = getSection('GEO').trim().toUpperCase();

  return {
    memoryMB: parseInt(getSection('MEMORY')) || 0,
    cpuCores: parseInt(getSection('CPU')) || 1,
    diskFreeGB: parseInt(getSection('DISK')) || 0,
    dockerInstalled: getSection('DOCKER') === 'yes',
    dockerComposeInstalled: getSection('COMPOSE') === 'yes',
    dockerHubReachable: getSection('DOCKERHUB') === 'reachable',
    npmReachable: getSection('NPM') === 'reachable',
    alpineReachable: getSection('ALPINE') === 'reachable',
    geoCountry: geo,
    githubApiReachable: getSection('GITHUBAPI') === 'reachable',
    needsChinaMirrors: geo === 'CN' || (!getSection('DOCKERHUB').includes('reachable') && !getSection('NPM').includes('reachable')),
  };
}
