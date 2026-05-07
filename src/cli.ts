import { stdin as input, stdout as output } from 'node:process';

import { reloadRuntimeConfigFromStorage } from '../config';

import { updateRuntimeSecrets } from './control-plane';
import * as logger from './logger';
import * as store from './store';
import * as x from './x';

import { runFetch, runPostAll } from './automation-service';

import type { Slot } from './types';

const SLOTS: Slot[] = [
  { id: 's1', label: '5:00 AM' },
  { id: 's2', label: '7:00 AM' },
  { id: 's3', label: '12:00 PM' },
  { id: 's4', label: '3:00 PM' },
];

const cmd = process.argv[2];

function readHidden(prompt: string): Promise<string> {
  if (!input.isTTY) {
    return new Promise(resolve => {
      let value = '';
      input.setEncoding('utf8');
      input.on('data', chunk => {
        value += chunk;
      });
      input.on('end', () => {
        resolve(value.split(/\r?\n/)[0]?.trim() || '');
      });
    });
  }

  return new Promise((resolve, reject) => {
    let value = '';
    const wasRaw = input.isRaw;

    function cleanup(): void {
      input.off('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
    }

    function onData(buffer: Buffer): void {
      const chunk = buffer.toString('utf8');
      for (const char of chunk) {
        if (char === '\u0003') {
          cleanup();
          output.write('\n');
          reject(new Error('Canceled'));
          return;
        }
        if (char === '\r' || char === '\n') {
          cleanup();
          output.write('\n');
          resolve(value.trim());
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    }

    output.write(prompt);
    input.setEncoding('utf8');
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

async function readSecret(key: string, prompt: string): Promise<string> {
  const fromEnv = process.env[key]?.trim();
  if (fromEnv) return fromEnv;
  const value = await readHidden(prompt);
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

async function main(): Promise<void> {
  switch (cmd) {
    case 'status': {
      const queue = store.getQueue();
      const memory = store.getMemoryStats();
      const xPublishState = store.getPlatformPublishState('x');
      console.log('\n-- Queue -------------------------');
      for (const slot of SLOTS) {
        const item = queue[slot.id];
        console.log(`  ${slot.label.padEnd(8)} ${item ? '* ' + (item.title || '').substring(0, 50) : '(empty)'}`);
      }
      console.log(`\n  Exhausted sources: ${memory.sources.exhausted}`);
      console.log(`  Banked sources:    ${memory.sources.banked}`);
      console.log(`  Ready angles:      ${memory.angles.ready}`);
      console.log(`  Queued angles:     ${memory.angles.queued}`);
      console.log(`  Published angles:  ${memory.angles.published}`);
      console.log(`  Legacy used IDs:   ${memory.legacyUsedIds}`);
      if (xPublishState?.publishBlockedUntil && Date.parse(xPublishState.publishBlockedUntil) > Date.now()) {
        console.log(`  X publish mode:    draft-only until ${xPublishState.publishBlockedUntil}`);
      }
      console.log('---------------------------------\n');
      break;
    }

    case 'queue': {
      const queue = store.getQueue();
      for (const slot of SLOTS) {
        const item = queue[slot.id];
        if (!item) continue;

        console.log(`\n[${slot.label}]`);
        console.log(`ANGLE: ${item.angleLabel || 'legacy'}${item.angleThesis ? ` -- ${item.angleThesis}` : ''}`);
        console.log('LINKEDIN:\n' + item.linkedin);
        console.log('THREADS:\n' + item.threads);
        console.log('\nX:\n' + item.x);
        console.log('\nINSTAGRAM:\n' + item.instagram);
        console.log('\nFACEBOOK:\n' + item.facebook);
        console.log('\nIMAGE URL:\n' + (item.imageUrl || 'none'));
        if (item.ids && Object.keys(item.ids).length) {
          console.log('\nPOSTED IDS:\n' + JSON.stringify(item.ids, null, 2));
        }
        if (item.publishErrors && Object.keys(item.publishErrors).length) {
          console.log('\nPUBLISH ERRORS:\n' + JSON.stringify(item.publishErrors, null, 2));
        }
      }
      break;
    }

    case 'history': {
      const history = store.getHistory().slice(0, 5);
      if (!history.length) {
        console.log('No history yet.');
        break;
      }

      for (const entry of history) {
        console.log(`\n[${entry.postedAt}] ${entry.slot} -- ${entry.title || ''}`);
        if (entry.angleLabel) {
          console.log(`Angle: ${entry.angleLabel}${entry.angleThesis ? ` -- ${entry.angleThesis}` : ''}`);
        }
        console.log(
          `LinkedIn: ${entry.ids?.linkedin || 'failed'} | ` +
          `Threads: ${entry.ids?.threads || 'failed'} | ` +
          `X: ${entry.ids?.x || 'failed'} | ` +
          `Instagram: ${entry.ids?.instagram || 'failed'} | ` +
          `Facebook: ${entry.ids?.facebook || 'failed'}`
        );
        if (entry.errors?.length) {
          console.log('Errors: ' + entry.errors.join(', '));
        }
      }
      break;
    }

    case 'memory': {
      const memory = store.getMemoryStats();
      console.log('\n-- Memory ------------------------');
      console.log(JSON.stringify(memory, null, 2));
      console.log('---------------------------------\n');
      break;
    }

    case 'fetch': {
      logger.info('Manual fetch triggered');
      const { stats } = await runFetch(SLOTS, { source: 'cli' }, logger);
      logger.info(
        `Done. filled:${stats.filled} reused:${stats.reusedAngles} extracted:${stats.extractedSources} exhausted:${stats.exhaustedSources}`
      );
      break;
    }

    case 'import-x-oauth2': {
      const accessToken = await readSecret('X_OAUTH2_ACCESS_TOKEN', 'X OAuth 2.0 access token: ');
      const refreshToken = await readSecret('X_OAUTH2_REFRESH_TOKEN', 'X OAuth 2.0 refresh token: ');

      updateRuntimeSecrets({
        X_OAUTH2_ACCESS_TOKEN: accessToken,
        X_OAUTH2_REFRESH_TOKEN: refreshToken,
      });
      reloadRuntimeConfigFromStorage();

      const me = await x.getAuthenticatedUser();
      store.clearPlatformPublishBlocked('x');
      console.log(`Saved X OAuth 2.0 user tokens for ${me.username ? '@' + me.username : me.name || me.id}.`);
      break;
    }

    case 'post-now': {
      logger.info('Manual post-now triggered');
      const { results } = await runPostAll(SLOTS, { source: 'cli' }, logger);
      for (const result of results) {
        if (result.skipped) {
          logger.warn(`${String(result.slot)} empty`);
          continue;
        }
        if (result.queuedForRetry) {
          logger.warn(`${String(result.slot)} retained | pending:${String((result.pendingPlatforms as string[] | undefined)?.join(',') || '')}`);
          continue;
        }
        logger.info(`${String(result.slot)} posted`);
      }
      break;
    }

    default:
      console.log(`
Social Agent CLI
----------------
  npm run fetch      Fill empty slots from banked angles or fresh Reddit sources
  npm run queue      Preview queued content per platform
  npm run status     Show slot fill status and memory counts
  npm run history    Last 5 posting batches
  npm run post-now   Post all slots immediately
  npm run memory     Show source and angle inventory
  npm run import-x-oauth2  Save X OAuth 2.0 user tokens from the X portal
  npm start          Start agent (cron + dashboard)
      `);
  }
}

void main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('CLI error:', message);
  process.exit(1);
});
