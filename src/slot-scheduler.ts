export const DAILY_SLOT_HOURS = [5, 7, 12, 15] as const;

export interface SlotOccupancyRow {
  platform?: string | null;
  slot_index?: number | null;
  scheduled_for?: string | null;
  scheduled_local_date?: string | null;
}

export interface ScheduledPlatformSlot {
  platform: string;
  slotIndex: number;
  localDate: string;
  localHour: number;
  scheduledFor: string;
}

export type PlatformSlotOccupancy = Set<string>;

export const ACTIVE_QUEUE_SLOT_STATUSES = ['pending', 'ready', 'publishing'] as const;

export interface QueueSlotUniquenessRow {
  user_id?: string | null;
  platform?: string | null;
  slot_index?: number | null;
  scheduled_local_date?: string | null;
  status?: string | null;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour12: false,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function safeTimeZone(timeZone: string | null | undefined): string {
  const candidate = String(timeZone || '').trim() || 'Europe/London';
  try {
    formatter(candidate).format(new Date());
    return candidate;
  } catch {
    return 'Europe/London';
  }
}

function partsForInstant(date: Date, timeZone: string): LocalParts {
  const values: Record<string, number> = {};
  for (const part of formatter(safeTimeZone(timeZone)).formatToParts(date)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

function localDateKey(parts: Pick<LocalParts, 'year' | 'month' | 'day'>): string {
  return [
    String(parts.year).padStart(4, '0'),
    String(parts.month).padStart(2, '0'),
    String(parts.day).padStart(2, '0'),
  ].join('-');
}

function offsetMsAt(date: Date, timeZone: string): number {
  const parts = partsForInstant(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  return asUtc - date.getTime();
}

function localDateTimeToUtc(
  parts: Pick<LocalParts, 'year' | 'month' | 'day'>,
  hour: number,
  timeZone: string
): Date {
  const initial = Date.UTC(parts.year, parts.month - 1, parts.day, hour, 0, 0);
  const firstOffset = offsetMsAt(new Date(initial), timeZone);
  let utc = initial - firstOffset;
  const secondOffset = offsetMsAt(new Date(utc), timeZone);
  if (secondOffset !== firstOffset) {
    utc = initial - secondOffset;
  }
  return new Date(utc);
}

function addLocalDays(parts: Pick<LocalParts, 'year' | 'month' | 'day'>, days: number): Pick<LocalParts, 'year' | 'month' | 'day'> {
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

export function tenantTimeZone(
  automationTimeZone: string | null | undefined,
  postingTimeZone?: string | null
): string {
  return safeTimeZone(automationTimeZone || postingTimeZone || 'Europe/London');
}

export function tenantLocalDateForInstant(value: string | Date, timeZone: string): string {
  const date = value instanceof Date ? value : new Date(value);
  return localDateKey(partsForInstant(date, timeZone));
}

export function tenantLocalDatePlusDays(
  value: string | Date,
  timeZone: string,
  days: number
): string {
  const date = value instanceof Date ? value : new Date(value);
  return localDateKey(addLocalDays(partsForInstant(date, timeZone), days));
}

export function nextOpenPlatformSlotForLocalDate(
  platform: string,
  occupied: PlatformSlotOccupancy,
  timeZone: string,
  targetLocalDate: string,
  now: Date = new Date()
): ScheduledPlatformSlot | undefined {
  const match = targetLocalDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return undefined;
  const localDay = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const validationDate = new Date(Date.UTC(localDay.year, localDay.month - 1, localDay.day, 12));
  if (
    validationDate.getUTCFullYear() !== localDay.year
    || validationDate.getUTCMonth() + 1 !== localDay.month
    || validationDate.getUTCDate() !== localDay.day
  ) {
    return undefined;
  }

  const normalizedPlatform = platform.trim();
  for (const [slotIndex, hour] of DAILY_SLOT_HOURS.entries()) {
    const scheduled = localDateTimeToUtc(localDay, hour, timeZone);
    if (scheduled.getTime() <= now.getTime()) continue;
    if (occupied.has(platformSlotOccupancyKey(normalizedPlatform, targetLocalDate, slotIndex))) continue;
    return {
      platform: normalizedPlatform,
      slotIndex,
      localDate: targetLocalDate,
      localHour: hour,
      scheduledFor: scheduled.toISOString(),
    };
  }

  return undefined;
}

export function platformSlotOccupancyKey(platform: string, localDate: string, slotIndex: number): string {
  return `${platform}:${localDate}:${slotIndex}`;
}

export function activeQueueSlotUniquenessKey(row: QueueSlotUniquenessRow): string | undefined {
  const status = String(row.status || '').trim();
  if (!ACTIVE_QUEUE_SLOT_STATUSES.includes(status as typeof ACTIVE_QUEUE_SLOT_STATUSES[number])) {
    return undefined;
  }
  const userId = String(row.user_id || '').trim();
  const platform = String(row.platform || '').trim();
  const localDate = String(row.scheduled_local_date || '').trim();
  const slotIndex = Number(row.slot_index);
  if (!userId || !platform || !localDate || !Number.isInteger(slotIndex)) {
    return undefined;
  }
  return `${userId}:${platform}:${localDate}:${slotIndex}`;
}

export function scheduledSlotWriteFields(
  slot: Pick<ScheduledPlatformSlot, 'localDate'>,
  timeZone: string
): { scheduled_local_date: string; scheduled_timezone: string } {
  return {
    scheduled_local_date: slot.localDate,
    scheduled_timezone: safeTimeZone(timeZone),
  };
}

export function buildPlatformSlotOccupancy(
  rows: SlotOccupancyRow[],
  timeZone: string
): PlatformSlotOccupancy {
  const occupied: PlatformSlotOccupancy = new Set();
  for (const row of rows) {
    const platform = String(row.platform || '').trim();
    const slotIndex = Number(row.slot_index);
    const scheduledFor = String(row.scheduled_for || '').trim();
    const localDate = String(row.scheduled_local_date || '').trim();
    if (!platform || !Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= DAILY_SLOT_HOURS.length || (!scheduledFor && !localDate)) {
      continue;
    }
    occupied.add(platformSlotOccupancyKey(platform, localDate || tenantLocalDateForInstant(scheduledFor, timeZone), slotIndex));
  }
  return occupied;
}

export function nextOpenPlatformSlot(
  platform: string,
  occupied: PlatformSlotOccupancy,
  timeZone: string,
  now: Date = new Date()
): ScheduledPlatformSlot {
  const normalizedPlatform = platform.trim();
  const localNow = partsForInstant(now, timeZone);

  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    const localDay = addLocalDays(localNow, dayOffset);
    const dateKey = localDateKey(localDay);
    for (const [slotIndex, hour] of DAILY_SLOT_HOURS.entries()) {
      const scheduled = localDateTimeToUtc(localDay, hour, timeZone);
      if (scheduled.getTime() <= now.getTime()) continue;
      if (occupied.has(platformSlotOccupancyKey(normalizedPlatform, dateKey, slotIndex))) continue;
      return {
        platform: normalizedPlatform,
        slotIndex,
        localDate: dateKey,
        localHour: hour,
        scheduledFor: scheduled.toISOString(),
      };
    }
  }

  const fallbackDay = addLocalDays(localNow, 8);
  const scheduled = localDateTimeToUtc(fallbackDay, DAILY_SLOT_HOURS[0], timeZone);
  return {
    platform: normalizedPlatform,
    slotIndex: 0,
    localDate: localDateKey(fallbackDay),
    localHour: DAILY_SLOT_HOURS[0],
    scheduledFor: scheduled.toISOString(),
  };
}
