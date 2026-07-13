import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { buildDailyInventoryPlan } from '../src/daily-inventory-planner';
import {
  DAILY_SLOT_HOURS,
  nextOpenPlatformSlotForLocalDate,
  platformSlotOccupancyKey,
  tenantLocalDatePlusDays,
} from '../src/slot-scheduler';

const TZ = 'Europe/London';
const PLATFORMS = ['threads', 'linkedin', 'instagram', 'x'];

test('planner targets the next tenant-local day', () => {
  assert.equal(
    tenantLocalDatePlusDays(new Date('2026-07-13T22:30:00.000Z'), TZ, 1),
    '2026-07-14',
  );
});

test('target-date slot selection schedules only the requested future day', () => {
  const slot = nextOpenPlatformSlotForLocalDate(
    'threads',
    new Set(),
    TZ,
    '2026-07-14',
    new Date('2026-07-13T12:00:00.000Z'),
  );

  assert.deepEqual(slot, {
    platform: 'threads',
    slotIndex: 0,
    localDate: '2026-07-14',
    localHour: 5,
    scheduledFor: '2026-07-14T04:00:00.000Z',
  });
});

test('target-date slot selection rejects invalid and elapsed dates', () => {
  assert.equal(
    nextOpenPlatformSlotForLocalDate('threads', new Set(), TZ, '2026-07-32'),
    undefined,
  );
  assert.equal(
    nextOpenPlatformSlotForLocalDate(
      'threads',
      new Set(),
      TZ,
      '2026-07-13',
      new Date('2026-07-13T15:00:00.000Z'),
    ),
    undefined,
  );
});

test('recovery execution reserves its slot without becoming an additive post', () => {
  const plan = buildDailyInventoryPlan(PLATFORMS, [
    {
      platform: 'threads',
      scheduled_local_date: '2026-07-16',
      slot_index: 0,
      status: 'ready',
    },
    {
      platform: 'threads',
      recovery_execution_id: 'recovery-1',
      scheduled_local_date: '2026-07-16',
      slot_index: 2,
      status: 'ready',
    },
  ], '2026-07-16');

  assert.equal(plan.requiredSlotCount, 16);
  assert.equal(plan.activeSlotCount, 2);
  assert.equal(plan.missingSlotCount, 14);
  assert.deepEqual(plan.platforms.threads, {
    activeSlotCount: 2,
    missingSlotIndexes: [1, 3],
    normalSlotCount: 1,
    recoverySlotCount: 1,
  });
});

test('complete four-by-four inventory includes normal and recovery slots once', () => {
  const rows = PLATFORMS.flatMap((platform) => DAILY_SLOT_HOURS.map((_hour, slotIndex) => ({
    platform,
    recovery_execution_id: platform === 'linkedin' && slotIndex === 2 ? 'recovery-linkedin' : null,
    scheduled_local_date: '2026-07-15',
    slot_index: slotIndex,
    status: 'ready',
  })));
  rows.push({
    platform: 'linkedin',
    recovery_execution_id: 'duplicate-recovery',
    scheduled_local_date: '2026-07-15',
    slot_index: 2,
    status: 'ready',
  });

  const plan = buildDailyInventoryPlan(PLATFORMS, rows, '2026-07-15');
  assert.equal(plan.complete, true);
  assert.equal(plan.activeSlotCount, 16);
  assert.equal(plan.missingSlotCount, 0);
  assert.equal(plan.platforms.linkedin.recoverySlotCount, 1);
});

test('planner wiring is future-dated and fail-closed', () => {
  const workerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'supabase-worker.ts'), 'utf8');
  assert.match(workerSource, /tenantLocalDatePlusDays\(now, timeZone, 1\)/);
  assert.match(workerSource, /mode: 'next_day_inventory'/);
  assert.match(workerSource, /target_local_date: targetLocalDate/);
  assert.match(workerSource, /intended_platform', operator: 'in' as const, value: plannedPlatforms/);
  assert.match(workerSource, /const sourceUrlsWithAngles = await loadSourceUrlsWithAngles\(userId\)/);
  assert.match(workerSource, /daily_inventory_insufficient/);
  assert.match(workerSource, /No post was fabricated/);
  assert.doesNotMatch(workerSource, /mode: 'next_day_inventory'[\s\S]{0,400}backfill/i);
});
