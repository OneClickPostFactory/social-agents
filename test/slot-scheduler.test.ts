import assert from 'node:assert/strict';

import {
  activeQueueSlotUniquenessKey,
  buildPlatformSlotOccupancy,
  nextOpenPlatformSlot,
  platformSlotOccupancyKey,
  scheduledSlotWriteFields,
  tenantLocalDateForInstant,
} from '../src/slot-scheduler';

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const TZ = 'Europe/London';

test('X slot 0 does not block Threads slot 0 on the same local day', () => {
  const occupied = new Set([platformSlotOccupancyKey('x', '2026-05-16', 0)]);
  const slot = nextOpenPlatformSlot('threads', occupied, TZ, new Date('2026-05-16T03:30:00.000Z'));

  assert.equal(slot.slotIndex, 0);
  assert.equal(slot.localDate, '2026-05-16');
  assert.equal(slot.scheduledFor, '2026-05-16T04:00:00.000Z');
});

test('LinkedIn slot 1 does not block Instagram slot 1 on the same local day', () => {
  const occupied = new Set([
    platformSlotOccupancyKey('instagram', '2026-05-16', 0),
    platformSlotOccupancyKey('linkedin', '2026-05-16', 1),
  ]);
  const slot = nextOpenPlatformSlot('instagram', occupied, TZ, new Date('2026-05-16T04:30:00.000Z'));

  assert.equal(slot.slotIndex, 1);
  assert.equal(slot.localDate, '2026-05-16');
  assert.equal(slot.scheduledFor, '2026-05-16T06:00:00.000Z');
});

test('at 10:30 Europe/London the next open slot is 12:00 today', () => {
  const slot = nextOpenPlatformSlot('x', new Set(), TZ, new Date('2026-05-16T09:30:00.000Z'));

  assert.equal(slot.slotIndex, 2);
  assert.equal(slot.localDate, '2026-05-16');
  assert.equal(slot.scheduledFor, '2026-05-16T11:00:00.000Z');
});

test('at 16:00 Europe/London the next open slot is tomorrow 05:00', () => {
  const slot = nextOpenPlatformSlot('x', new Set(), TZ, new Date('2026-05-16T15:00:00.000Z'));

  assert.equal(slot.slotIndex, 0);
  assert.equal(slot.localDate, '2026-05-17');
  assert.equal(slot.scheduledFor, '2026-05-17T04:00:00.000Z');
});

test('if X 12:00 is occupied but Threads 12:00 is open, Threads can use 12:00', () => {
  const occupied = new Set([platformSlotOccupancyKey('x', '2026-05-16', 2)]);
  const slot = nextOpenPlatformSlot('threads', occupied, TZ, new Date('2026-05-16T09:30:00.000Z'));

  assert.equal(slot.slotIndex, 2);
  assert.equal(slot.localDate, '2026-05-16');
  assert.equal(slot.scheduledFor, '2026-05-16T11:00:00.000Z');
});

test('Europe/London BST conversion stores the correct UTC scheduled_for', () => {
  assert.equal(
    tenantLocalDateForInstant('2026-05-16T11:00:00.000Z', TZ),
    '2026-05-16'
  );
  assert.equal(
    tenantLocalDateForInstant('2026-05-16T23:30:00.000Z', TZ),
    '2026-05-17'
  );
});

test('same user platform date slot occupancy prevents duplicate slot selection', () => {
  const occupied = buildPlatformSlotOccupancy([
    { platform: 'x', slot_index: 2, scheduled_for: '2026-05-16T11:00:00.000Z' },
  ], TZ);
  const slot = nextOpenPlatformSlot('x', occupied, TZ, new Date('2026-05-16T09:30:00.000Z'));

  assert.equal(slot.slotIndex, 3);
  assert.equal(slot.localDate, '2026-05-16');
  assert.equal(slot.scheduledFor, '2026-05-16T14:00:00.000Z');
});

test('same user platform local date slot has one active DB uniqueness key', () => {
  const first = activeQueueSlotUniquenessKey({
    user_id: 'tenant-1',
    platform: 'x',
    scheduled_local_date: '2026-05-16',
    slot_index: 2,
    status: 'ready',
  });
  const duplicate = activeQueueSlotUniquenessKey({
    user_id: 'tenant-1',
    platform: 'x',
    scheduled_local_date: '2026-05-16',
    slot_index: 2,
    status: 'pending',
  });

  assert.equal(first, duplicate);
});

test('same user different platform same local date slot is allowed by DB key', () => {
  const xKey = activeQueueSlotUniquenessKey({
    user_id: 'tenant-1',
    platform: 'x',
    scheduled_local_date: '2026-05-16',
    slot_index: 2,
    status: 'ready',
  });
  const threadsKey = activeQueueSlotUniquenessKey({
    user_id: 'tenant-1',
    platform: 'threads',
    scheduled_local_date: '2026-05-16',
    slot_index: 2,
    status: 'ready',
  });

  assert.notEqual(xKey, threadsKey);
});

test('same platform same slot on different local dates is allowed by DB key', () => {
  const today = activeQueueSlotUniquenessKey({
    user_id: 'tenant-1',
    platform: 'x',
    scheduled_local_date: '2026-05-16',
    slot_index: 2,
    status: 'ready',
  });
  const tomorrow = activeQueueSlotUniquenessKey({
    user_id: 'tenant-1',
    platform: 'x',
    scheduled_local_date: '2026-05-17',
    slot_index: 2,
    status: 'ready',
  });

  assert.notEqual(today, tomorrow);
});

test('published row does not produce an active DB uniqueness key', () => {
  assert.equal(activeQueueSlotUniquenessKey({
    user_id: 'tenant-1',
    platform: 'x',
    scheduled_local_date: '2026-05-16',
    slot_index: 2,
    status: 'published',
  }), undefined);
});

test('queue insert writes scheduled local date and timezone fields', () => {
  const slot = nextOpenPlatformSlot('x', new Set(), TZ, new Date('2026-05-16T09:30:00.000Z'));
  const fields = scheduledSlotWriteFields(slot, TZ);

  assert.equal(fields.scheduled_local_date, '2026-05-16');
  assert.equal(fields.scheduled_timezone, 'Europe/London');
});
