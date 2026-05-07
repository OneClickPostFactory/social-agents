import cron from 'node-cron';

import config from '../config';

import * as logger from './logger';

import { runFetch, runPostSlot } from './automation-service';
import { getMemoryStats, getSlotPost } from './store';
import { getAutomationGate, getEnabledPlatformLabels } from './runtime-policy';
import { startServer } from './server';
import { startSupabaseWorkerLoop } from './supabase-worker';

import type { Slot } from './types';

const SLOTS: Slot[] = [
  { id: 's1', cron: '0 5  * * *', label: '5:00 AM' },
  { id: 's2', cron: '0 7  * * *', label: '7:00 AM' },
  { id: 's3', cron: '0 12 * * *', label: '12:00 PM' },
  { id: 's4', cron: '0 15 * * *', label: '3:00 PM' },
];

function logAutomationGate(prefix: string): void {
  const gate = getAutomationGate();
  const billingSuffix = gate.localBillingBypassActive
    ? ' | LOCAL DEV BILLING BYPASS ACTIVE'
    : '';
  if (gate.allowed) {
    logger.info(
      `${prefix} | automation ready | platforms:${gate.readiness.enabledPlatforms.join(', ') || 'none'} | billing:${gate.billing.status}${billingSuffix}`
    );
    return;
  }

  logger.warn(`${prefix} | automation paused | ${gate.reasons.join(' | ')}${billingSuffix}`);
}

async function refresh(): Promise<void> {
  const gate = getAutomationGate();
  if (!gate.allowed) {
    logger.warn(`Refresh skipped | ${gate.reasons.join(' | ')}`);
    return;
  }

  logger.info(`=== Social Agent refresh | u/${config.REDDIT_USER} ===`);
  const { stats } = await runFetch(SLOTS, { source: 'cron' }, logger);
  const memory = getMemoryStats();

  logger.info(
    `Refresh summary | fetched:${stats.fetched} filled:${stats.filled} reused:${stats.reusedAngles} extracted:${stats.extractedSources} exhausted:${stats.exhaustedSources}`
  );
  logger.info(
    `Memory summary | sources banked:${memory.sources.banked} exhausted:${memory.sources.exhausted} | angles ready:${memory.angles.ready} queued:${memory.angles.queued} published:${memory.angles.published}`
  );
  logger.info('=== Refresh done ===');
}

async function fireSlot(slot: Slot): Promise<void> {
  const gate = getAutomationGate();
  if (!gate.allowed) {
    logger.warn(`${slot.label} skipped | ${gate.reasons.join(' | ')}`);
    return;
  }

  const item = getSlotPost(slot.id);
  if (!item) {
    logger.warn(`${slot.label} slot empty | skipping`);
    return;
  }

  const enabledLabels = getEnabledPlatformLabels();
  logger.info(
    `Firing ${slot.label} | posting to ${enabledLabels.length ? enabledLabels.join(', ') : 'no enabled platforms'}`
  );

  const result = await runPostSlot(slot, { source: 'cron' }, logger);

  if (result.success) {
    logger.info(`${slot.label} posted successfully`);
  } else {
    logger.warn(`${slot.label} retained in queue for retry | pending:${result.pendingPlatforms.join(', ')}`);
  }
}

async function start(): Promise<void> {
  logger.info('Social Agent starting');
  startServer();
  startSupabaseWorkerLoop(logger);
  logAutomationGate('Startup status');

  cron.schedule('30 4 * * *', () => {
    void refresh();
  }, { timezone: config.TIMEZONE });
  logger.info('Daily refresh scheduled at 4:30 AM');

  for (const slot of SLOTS) {
    cron.schedule(slot.cron!, () => {
      void fireSlot(slot);
    }, { timezone: config.TIMEZONE });
    logger.info(`Slot scheduled: ${slot.label}`);
  }

  await refresh();
  logger.info(`Social Agent running | dashboard/api http://localhost:${config.GUI_PORT}`);
}

void start().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(`Fatal: ${message}`);
  process.exit(1);
});
