import * as fs from 'node:fs';
import * as path from 'node:path';

function nowStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return undefined;
}

export function resolveDataDir(): string {
  return process.env.APP_DATA_DIR
    ? path.resolve(process.env.APP_DATA_DIR)
    : path.join(process.cwd(), 'data');
}

export function createBackup(sourceDir = resolveDataDir(), backupRoot = path.join(process.cwd(), 'backups')): string {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Data directory not found: ${sourceDir}`);
  }

  fs.mkdirSync(backupRoot, { recursive: true });
  const destination = path.join(backupRoot, nowStamp());
  fs.cpSync(sourceDir, destination, { recursive: true, force: false });
  return destination;
}

if (require.main === module) {
  const sourceDir = getArg('--source') ? path.resolve(getArg('--source')!) : resolveDataDir();
  const backupRoot = getArg('--output') ? path.resolve(getArg('--output')!) : path.join(process.cwd(), 'backups');
  const destination = createBackup(sourceDir, backupRoot);
  console.log(destination);
}
