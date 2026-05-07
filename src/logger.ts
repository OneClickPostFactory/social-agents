import * as fs from 'node:fs';
import * as path from 'node:path';

function getProjectRoot(): string {
  if (process.env.CF_WORKER_RUNTIME === 'true') {
    return '/';
  }

  const parent = path.resolve(__dirname, '..');
  return path.basename(parent) === 'dist'
    ? path.resolve(parent, '..')
    : parent;
}

const LOG_DIR = process.env.APP_DATA_DIR
  ? path.resolve(process.env.APP_DATA_DIR)
  : path.join(getProjectRoot(), 'data');
const LOG_FILE = path.join(LOG_DIR, 'agent.log');

try {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
} catch {
  // Edge runtimes can be read-only; stdout logging still works there.
}

function timestamp(): string {
  return new Date().toISOString();
}

function write(level: string, message: string, fields?: Record<string, unknown>): void {
  const payload = {
    timestamp: timestamp(),
    level: level.trim(),
    message,
    ...(fields || {}),
  };
  const line = JSON.stringify(payload);
  console.log(line);

  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {
    // Ignore logging failures so the agent can keep running.
  }
}

export function info(message: string, fields?: Record<string, unknown>): void {
  write('INFO ', message, fields);
}

export function warn(message: string, fields?: Record<string, unknown>): void {
  write('WARN ', message, fields);
}

export function error(message: string, fields?: Record<string, unknown>): void {
  write('ERROR', message, fields);
}
