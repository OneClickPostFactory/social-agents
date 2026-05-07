import { execFileSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';

import config from '../config';

import { createBackup } from './backup';

function bin(name: string): string {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return undefined;
}

function run(command: string, args: string[]): void {
  execFileSync(command, args, {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
}

function ensureCleanWorktree(): void {
  const output = execFileSync('git', ['status', '--porcelain'], {
    encoding: 'utf8',
    cwd: process.cwd(),
  }).trim();

  if (output) {
    throw new Error('Refusing to deploy with a dirty worktree');
  }
}

function checkHealth(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, res => {
      if ((res.statusCode || 500) >= 400) {
        reject(new Error(`Health check failed with HTTP ${res.statusCode}`));
        return;
      }
      resolve();
    });
    req.on('error', reject);
    req.end();
  });
}

async function main(): Promise<void> {
  const ref = getArg('--ref') || 'origin/main';
  const runtimeEntry = 'dist/src/agent.js';

  ensureCleanWorktree();
  const backupPath = createBackup();
  console.log(`Backup created at ${backupPath}`);

  run('git', ['fetch', '--all', '--prune']);
  run('git', ['merge', '--ff-only', ref]);
  run(bin('npm'), ['ci']);
  run(bin('npm'), ['run', 'ci']);

  try {
    run(bin('pm2'), ['delete', 'social-agent']);
  } catch {}

  run(bin('pm2'), ['start', runtimeEntry, '--name', 'social-agent', '--restart-delay=5000']);
  run(bin('pm2'), ['save']);

  await checkHealth(`http://127.0.0.1:${config.GUI_PORT}/healthz`);
  console.log('Deploy completed successfully');
}

void main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Deploy failed: ${message}`);
  process.exit(1);
});
