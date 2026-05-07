import { badRequest, forbidden } from './errors';

import * as logger from './logger';
import * as store from './store';

import { fillEmptySlots, finalizePublishResult, hydrateQueuedItemForActivePlatforms, releaseSlot as releaseQueueSlot } from './content-engine';
import { publishQueuedItem } from './publish';
import { getAutomationGate } from './runtime-policy';

import type { FillQueueStats, Logger, QueueItem, Slot } from './types';

export interface AutomationActor {
  source: 'api' | 'cli' | 'cron' | 'system';
  userId?: number;
  requestId?: string;
}

interface PublishExecution {
  item: QueueItem;
  result: Awaited<ReturnType<typeof publishQueuedItem>>;
}

function actorOwner(actor?: AutomationActor): string {
  if (!actor) return 'system';
  return [actor.source, actor.userId || 'anon', actor.requestId || 'no-request'].join(':');
}

function withAutomationRunLock<T>(actor: AutomationActor | undefined, fn: () => Promise<T> | T): Promise<T> {
  return store.withAutomationLock('automation:run', actorOwner(actor), fn);
}

function assertAutomationAllowed(): void {
  const gate = getAutomationGate();
  if (!gate.allowed) {
    forbidden('Automation is not available', 'AUTOMATION_BLOCKED', { gate });
  }
}

async function executePublish(slot: Slot, item: QueueItem, log: Logger): Promise<PublishExecution> {
  const hydratedItem = await hydrateQueuedItemForActivePlatforms(slot.id, item, log);
  const result = await publishQueuedItem(hydratedItem, log);
  finalizePublishResult(slot, hydratedItem, result);
  return {
    item: hydratedItem,
    result,
  };
}

export async function runFetch(slots: Slot[], actor?: AutomationActor, log: Logger = logger): Promise<{
  stats: FillQueueStats;
  memory: ReturnType<typeof store.getMemoryStats>;
}> {
  assertAutomationAllowed();
  return withAutomationRunLock(actor, async () => {
    const stats = await fillEmptySlots(slots, log);
    return {
      stats,
      memory: store.getMemoryStats(),
    };
  });
}

export async function runPostSlot(slot: Slot, actor?: AutomationActor, log: Logger = logger): Promise<{
  queuedForRetry: boolean;
  ids: PublishExecution['result']['ids'];
  errors: PublishExecution['result']['errors'];
  pendingPlatforms: PublishExecution['result']['pendingPlatforms'];
  memory: ReturnType<typeof store.getMemoryStats>;
  success: boolean;
}> {
  assertAutomationAllowed();
  return withAutomationRunLock(actor, async () => {
    const item = store.getSlotPost(slot.id);
    if (!item) {
      badRequest('Slot is empty', 'EMPTY_SLOT');
    }

    const execution = await executePublish(slot, item, log);
    return {
      queuedForRetry: !execution.result.completed,
      ids: execution.result.ids,
      errors: execution.result.errors,
      pendingPlatforms: execution.result.pendingPlatforms,
      memory: store.getMemoryStats(),
      success: execution.result.completed,
    };
  });
}

export async function runPostAll(slots: Slot[], actor?: AutomationActor, log: Logger = logger): Promise<{
  results: Array<Record<string, unknown>>;
  memory: ReturnType<typeof store.getMemoryStats>;
}> {
  assertAutomationAllowed();
  return withAutomationRunLock(actor, async () => {
    const results: Array<Record<string, unknown>> = [];

    for (const slot of slots) {
      const item = store.getSlotPost(slot.id);
      if (!item) {
        results.push({ slot: slot.label, skipped: true });
        continue;
      }

      const execution = await executePublish(slot, item, log);
      results.push({
        slot: slot.label,
        ids: execution.result.ids,
        errors: execution.result.errors,
        queuedForRetry: !execution.result.completed,
        pendingPlatforms: execution.result.pendingPlatforms,
      });
    }

    return {
      results,
      memory: store.getMemoryStats(),
    };
  });
}

export async function runReleaseSlot(slot: Slot, actor?: AutomationActor): Promise<{
  released: boolean;
  item: QueueItem | null;
  memory: ReturnType<typeof store.getMemoryStats>;
}> {
  assertAutomationAllowed();
  return withAutomationRunLock(actor, async () => {
    const item = releaseQueueSlot(slot.id);
    return {
      released: Boolean(item),
      item,
      memory: store.getMemoryStats(),
    };
  });
}

export async function runUpdateSlot(
  slot: Slot,
  updates: Partial<QueueItem>,
  actor?: AutomationActor
): Promise<{ success: true; memory: ReturnType<typeof store.getMemoryStats> }> {
  assertAutomationAllowed();
  return withAutomationRunLock(actor, async () => {
    const existing = store.getSlotPost(slot.id);
    if (!existing) {
      badRequest('Slot is empty', 'EMPTY_SLOT');
    }

    store.setSlotPost(slot.id, { ...existing, ...updates });
    return {
      success: true as const,
      memory: store.getMemoryStats(),
    };
  });
}
