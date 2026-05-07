import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');
const TSC_BIN = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const RUNTIME_ASSETS = ['public', 'content-os'];

function cleanDist(): void {
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });
}

function runTypeScriptBuild(): void {
  execFileSync(process.execPath, [TSC_BIN, '--project', path.join(ROOT, 'tsconfig.json')], {
    stdio: 'inherit',
    cwd: ROOT,
  });
}

function copyRuntimeAsset(relativePath: string): void {
  const source = path.join(ROOT, relativePath);
  if (!fs.existsSync(source)) {
    return;
  }

  const destination = path.join(DIST_DIR, relativePath);
  fs.cpSync(source, destination, { recursive: true, force: true });
}

function main(): void {
  cleanDist();
  runTypeScriptBuild();
  for (const relativePath of RUNTIME_ASSETS) {
    copyRuntimeAsset(relativePath);
  }
}

main();
