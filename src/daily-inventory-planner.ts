import { DAILY_SLOT_HOURS } from "./slot-scheduler";

const ACTIVE_QUEUE_STATUSES = new Set(["pending", "ready", "publishing"]);

export interface DailyInventoryQueueRow {
  platform?: string | null;
  recovery_execution_id?: string | null;
  scheduled_local_date?: string | null;
  slot_index?: number | null;
  status?: string | null;
}

export interface PlatformInventoryPlan {
  activeSlotCount: number;
  missingSlotIndexes: number[];
  normalSlotCount: number;
  recoverySlotCount: number;
}

export interface DailyInventoryPlan {
  activeSlotCount: number;
  complete: boolean;
  missingSlotCount: number;
  platforms: Record<string, PlatformInventoryPlan>;
  requiredSlotCount: number;
  targetLocalDate: string;
}

export function buildDailyInventoryPlan(
  platforms: string[],
  rows: DailyInventoryQueueRow[],
  targetLocalDate: string,
): DailyInventoryPlan {
  const planByPlatform: Record<string, PlatformInventoryPlan> = {};

  for (const platform of platforms) {
    const normalSlots = new Set<number>();
    const recoverySlots = new Set<number>();

    for (const row of rows) {
      const slotIndex = Number(row.slot_index);
      if (
        row.platform !== platform
        || row.scheduled_local_date !== targetLocalDate
        || !ACTIVE_QUEUE_STATUSES.has(String(row.status || ""))
        || !Number.isInteger(slotIndex)
        || slotIndex < 0
        || slotIndex >= DAILY_SLOT_HOURS.length
      ) {
        continue;
      }

      if (String(row.recovery_execution_id || "").trim()) recoverySlots.add(slotIndex);
      else normalSlots.add(slotIndex);
    }

    const occupiedSlots = new Set([...normalSlots, ...recoverySlots]);
    planByPlatform[platform] = {
      activeSlotCount: occupiedSlots.size,
      normalSlotCount: normalSlots.size,
      recoverySlotCount: recoverySlots.size,
      missingSlotIndexes: DAILY_SLOT_HOURS.map((_, slotIndex) => slotIndex).filter(
        (slotIndex) => !occupiedSlots.has(slotIndex),
      ),
    };
  }

  const requiredSlotCount = platforms.length * DAILY_SLOT_HOURS.length;
  const activeSlotCount = Object.values(planByPlatform).reduce(
    (total, platform) => total + platform.activeSlotCount,
    0,
  );

  return {
    activeSlotCount,
    complete: requiredSlotCount > 0 && activeSlotCount === requiredSlotCount,
    missingSlotCount: Math.max(0, requiredSlotCount - activeSlotCount),
    platforms: planByPlatform,
    requiredSlotCount,
    targetLocalDate,
  };
}
