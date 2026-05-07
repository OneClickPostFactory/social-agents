import * as fs from 'node:fs';
import * as path from 'node:path';

import { resolveDataDir } from './backup';

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return undefined;
}

export function restoreBackup(sourceDir: string, targetDir = resolveDataDir()): string {
  const resolvedSource = path.resolve(sourceDir);
  const resolvedTarget = path.resolve(targetDir);

  if (!fs.existsSync(resolvedSource)) {
    throw new Error(`Backup directory not found: ${resolvedSource}`);
  }

  fs.mkdirSync(resolvedTarget, { recursive: true });
  fs.rmSync(resolvedTarget, { recursive: true, force: true });
  fs.mkdirSync(resolvedTarget, { recursive: true });
  fs.cpSync(resolvedSource, resolvedTarget, { recursive: true, force: true });
  return resolvedTarget;
}

if (require.main === module) {
  const sourceDir = getArg('--from');
  if (!sourceDir) {
    throw new Error('Usage: npm run restore -- --from <backup-dir> [--to <target-dir>]');
  }

  const targetDir = getArg('--to') ? path.resolve(getArg('--to')!) : resolveDataDir();
  const restoredTo = restoreBackup(sourceDir, targetDir);
  console.log(restoredTo);
}
