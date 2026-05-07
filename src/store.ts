import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { locked } from './errors';

import type {
  AngleRecord,
  HistoryEntry,
  MemoryStats,
  PlatformKey,
  PlatformPublishState,
  PlatformPublishStateMap,
  QueueItem,
  QueueState,
  SlotId,
  SourceExtraction,
  SourceRecord,
} from './types';

function getProjectRoot(): string {
  const parent = path.resolve(__dirname, '..');
  return path.basename(parent) === 'dist'
    ? path.resolve(parent, '..')
    : parent;
}

const DATA_DIR = process.env.APP_DATA_DIR
  ? path.resolve(process.env.APP_DATA_DIR)
  : path.join(getProjectRoot(), 'data');
const DB_FILE = path.join(DATA_DIR, 'automation.sqlite');
const QUEUE_FILE = path.join(DATA_DIR, 'queue.json');
const USED_FILE = path.join(DATA_DIR, 'used_ids.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const SOURCES_FILE = path.join(DATA_DIR, 'sources.json');
const ANGLES_FILE = path.join(DATA_DIR, 'angles.json');
const PLATFORM_STATE_FILE = path.join(DATA_DIR, 'platform-state.json');

const SLOT_IDS: SlotId[] = ['s1', 's2', 's3', 's4'];
const EMPTY_QUEUE: QueueState = { s1: null, s2: null, s3: null, s4: null };

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS app_queue (
    slot_id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_used_ids (
    reddit_id TEXT PRIMARY KEY,
    marked_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    posted_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_sources (
    reddit_id TEXT PRIMARY KEY,
    created INTEGER NOT NULL,
    status TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_angles (
    id TEXT PRIMARY KEY,
    reddit_id TEXT NOT NULL,
    status TEXT NOT NULL,
    source_created INTEGER NOT NULL,
    strength INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_platform_state (
    platform_key TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_automation_locks (
    lock_key TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_store_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

function nowIso(): string {
  return new Date().toISOString();
}

function readLegacyJSON<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function parsePayload<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function transaction<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore rollback failures
    }
    throw error;
  }
}

function setMeta(key: string, value: string): void {
  db.prepare(`
    INSERT INTO app_store_meta (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, nowIso());
}

function getMeta(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM app_store_meta WHERE key = ?').get(key) as { value?: string } | undefined;
  return row?.value;
}

function getTableCount(tableName: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number };
  return Number(row.count || 0);
}

function sortAngles(a: AngleRecord, b: AngleRecord): number {
  return (
    b.sourceCreated - a.sourceCreated ||
    b.strength - a.strength ||
    a.id.localeCompare(b.id)
  );
}

function uniqStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function putQueueItem(slotId: SlotId, item: QueueItem): void {
  db.prepare(`
    INSERT INTO app_queue (slot_id, payload_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(slot_id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at
  `).run(slotId, JSON.stringify(item), nowIso());
}

function removeQueueItem(slotId: SlotId): void {
  db.prepare('DELETE FROM app_queue WHERE slot_id = ?').run(slotId);
}

function putSource(source: SourceRecord): void {
  db.prepare(`
    INSERT INTO app_sources (reddit_id, created, status, payload_json, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(reddit_id) DO UPDATE SET
      created = excluded.created,
      status = excluded.status,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `).run(source.redditId, source.created, source.status, JSON.stringify(source), nowIso());
}

function putAngle(angle: AngleRecord): void {
  db.prepare(`
    INSERT INTO app_angles (id, reddit_id, status, source_created, strength, payload_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      reddit_id = excluded.reddit_id,
      status = excluded.status,
      source_created = excluded.source_created,
      strength = excluded.strength,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `).run(angle.id, angle.redditId, angle.status, angle.sourceCreated, angle.strength, JSON.stringify(angle), nowIso());
}

function trimHistory(): void {
  db.prepare(`
    DELETE FROM app_history
    WHERE id IN (
      SELECT id FROM app_history
      ORDER BY posted_at DESC, id DESC
      LIMIT -1 OFFSET 200
    )
  `).run();
}

function markUsedDirect(id: string): void {
  db.prepare(`
    INSERT INTO app_used_ids (reddit_id, marked_at)
    VALUES (?, ?)
    ON CONFLICT(reddit_id) DO UPDATE SET marked_at = excluded.marked_at
  `).run(id, nowIso());

  db.prepare(`
    DELETE FROM app_used_ids
    WHERE reddit_id IN (
      SELECT reddit_id FROM app_used_ids
      ORDER BY marked_at DESC, reddit_id DESC
      LIMIT -1 OFFSET 1000
    )
  `).run();
}

function putPlatformState(platform: PlatformKey, state: PlatformPublishState): void {
  db.prepare(`
    INSERT INTO app_platform_state (platform_key, payload_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(platform_key) DO UPDATE SET
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `).run(platform, JSON.stringify(state), nowIso());
}

function importLegacyDataIfNeeded(): void {
  if (getMeta('legacy_json_imported_at')) {
    return;
  }

  const hasExistingData = [
    'app_queue',
    'app_used_ids',
    'app_history',
    'app_sources',
    'app_angles',
    'app_platform_state',
  ].some(table => getTableCount(table) > 0);

  if (!hasExistingData) {
    const queue = readLegacyJSON(QUEUE_FILE, EMPTY_QUEUE);
    const usedIds = readLegacyJSON(USED_FILE, [] as string[]);
    const history = readLegacyJSON(HISTORY_FILE, [] as HistoryEntry[]);
    const sources = readLegacyJSON(SOURCES_FILE, [] as SourceRecord[]);
    const angles = readLegacyJSON(ANGLES_FILE, [] as AngleRecord[]);
    const platformState = readLegacyJSON(PLATFORM_STATE_FILE, {} as PlatformPublishStateMap);

    transaction(() => {
      for (const slotId of SLOT_IDS) {
        const item = queue[slotId];
        if (item) {
          putQueueItem(slotId, item);
        }
      }

      usedIds.forEach(id => markUsedDirect(id));

      for (const entry of history) {
        db.prepare(`
          INSERT INTO app_history (posted_at, payload_json)
          VALUES (?, ?)
        `).run(entry.postedAt || nowIso(), JSON.stringify(entry));
      }
      trimHistory();

      for (const source of sources) {
        putSource(source);
      }

      for (const angle of angles) {
        putAngle(angle);
      }

      for (const [platform, state] of Object.entries(platformState) as Array<[PlatformKey, PlatformPublishState]>) {
        putPlatformState(platform, state);
      }
    });
  }

  setMeta('legacy_json_imported_at', nowIso());
}

function readQueueRow(slotId: SlotId): QueueItem | null {
  const row = db.prepare('SELECT payload_json FROM app_queue WHERE slot_id = ?').get(slotId) as { payload_json?: string } | undefined;
  return row?.payload_json ? parsePayload<QueueItem | null>(row.payload_json, null) : null;
}

importLegacyDataIfNeeded();

export function getQueue(): QueueState {
  const queue: QueueState = { ...EMPTY_QUEUE };
  const rows = db.prepare('SELECT slot_id, payload_json FROM app_queue').all() as Array<{ slot_id: SlotId; payload_json: string }>;

  for (const row of rows) {
    if (SLOT_IDS.includes(row.slot_id)) {
      queue[row.slot_id] = parsePayload<QueueItem | null>(row.payload_json, null);
    }
  }

  return queue;
}

export function getSlotPost(slotId: keyof QueueState): QueueItem | null {
  return readQueueRow(slotId);
}

export function setSlotPost(slotId: keyof QueueState, item: QueueItem): void {
  transaction(() => {
    putQueueItem(slotId, item);
  });
}

export function clearSlotPost(slotId: keyof QueueState): void {
  transaction(() => {
    removeQueueItem(slotId);
  });
}

export function getUsedIds(): Set<string> {
  const rows = db.prepare(`
    SELECT reddit_id FROM app_used_ids
    ORDER BY marked_at DESC, reddit_id DESC
  `).all() as Array<{ reddit_id: string }>;
  return new Set(rows.map(row => row.reddit_id));
}

export function markUsed(id: string): void {
  transaction(() => {
    markUsedDirect(id);
  });
}

export function logHistory(entry: HistoryEntry): void {
  transaction(() => {
    db.prepare(`
      INSERT INTO app_history (posted_at, payload_json)
      VALUES (?, ?)
    `).run(entry.postedAt || nowIso(), JSON.stringify(entry));
    trimHistory();
  });
}

export function getHistory(): HistoryEntry[] {
  const rows = db.prepare(`
    SELECT payload_json FROM app_history
    ORDER BY posted_at DESC, id DESC
  `).all() as Array<{ payload_json: string }>;
  return rows.map(row => parsePayload<HistoryEntry>(row.payload_json, {} as HistoryEntry));
}

export function getPostsPendingPoll(): HistoryEntry[] {
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;
  const twoDays = 48 * 60 * 60 * 1000;

  return getHistory().filter(entry => {
    if (!entry.postedAt || entry.engagement?.polledAt) {
      return false;
    }

    const age = now - new Date(entry.postedAt).getTime();
    return age >= oneDay && age <= twoDays;
  });
}

export function updateEngagement(postedAt: string, engagement: Record<string, unknown>): void {
  transaction(() => {
    const rows = db.prepare(`
      SELECT id, payload_json FROM app_history
      ORDER BY posted_at DESC, id DESC
    `).all() as Array<{ id: number; payload_json: string }>;

    const target = rows.find(row => parsePayload<HistoryEntry>(row.payload_json, {} as HistoryEntry).postedAt === postedAt);
    if (!target) {
      return;
    }

    const entry = parsePayload<HistoryEntry>(target.payload_json, {} as HistoryEntry);
    entry.engagement = {
      ...engagement,
      polledAt: nowIso(),
    };

    db.prepare('UPDATE app_history SET payload_json = ? WHERE id = ?').run(JSON.stringify(entry), target.id);
  });
}

export function getSources(): SourceRecord[] {
  const rows = db.prepare(`
    SELECT payload_json FROM app_sources
    ORDER BY created DESC, reddit_id ASC
  `).all() as Array<{ payload_json: string }>;
  return rows.map(row => parsePayload<SourceRecord>(row.payload_json, {} as SourceRecord));
}

export function getSource(redditId: string): SourceRecord | undefined {
  const row = db.prepare('SELECT payload_json FROM app_sources WHERE reddit_id = ?').get(redditId) as { payload_json?: string } | undefined;
  return row?.payload_json ? parsePayload<SourceRecord>(row.payload_json, {} as SourceRecord) : undefined;
}

export function getAngles(): AngleRecord[] {
  const rows = db.prepare(`
    SELECT payload_json FROM app_angles
    ORDER BY source_created DESC, strength DESC, id ASC
  `).all() as Array<{ payload_json: string }>;
  return rows.map(row => parsePayload<AngleRecord>(row.payload_json, {} as AngleRecord));
}

export function getAngle(angleId: string): AngleRecord | undefined {
  const row = db.prepare('SELECT payload_json FROM app_angles WHERE id = ?').get(angleId) as { payload_json?: string } | undefined;
  return row?.payload_json ? parsePayload<AngleRecord>(row.payload_json, {} as AngleRecord) : undefined;
}

export function getAnglesForSource(redditId: string): AngleRecord[] {
  return getAngles()
    .filter(angle => angle.redditId === redditId)
    .sort(sortAngles);
}

export function getReadyAngles(limit?: number, excludeRedditIds?: Set<string>): AngleRecord[] {
  const excluded = excludeRedditIds || new Set<string>();
  const ready = getAngles()
    .filter(angle => angle.status === 'ready' && !excluded.has(angle.redditId))
    .sort(sortAngles);

  return typeof limit === 'number' ? ready.slice(0, limit) : ready;
}

export function getNextReadyAngleForSource(
  redditId: string,
  expectedHash?: string
): AngleRecord | undefined {
  return getAnglesForSource(redditId)
    .filter(angle => angle.status === 'ready')
    .find(angle => !expectedHash || angle.sourceHash === expectedHash);
}

export function sourceHasActiveAngles(redditId: string): boolean {
  return getAnglesForSource(redditId).some(angle => angle.status === 'ready' || angle.status === 'queued');
}

export function isSourceExhausted(redditId: string, contentHash: string): boolean {
  const source = getSource(redditId);
  if (source) {
    if (source.contentHash !== contentHash) return false;
    return source.status === 'exhausted';
  }

  return getUsedIds().has(redditId);
}

export function bankSourceExtraction(
  post: {
    id: string;
    title: string;
    selftext: string;
    url: string;
    subreddit: string;
    author: string;
    created: number;
  },
  contentHash: string,
  extraction: SourceExtraction
): { source: SourceRecord; readyAngles: AngleRecord[] } {
  return transaction(() => {
    const now = nowIso();
    const existingSource = getSource(post.id);
    const matchingAngles = getAngles()
      .filter(angle => angle.redditId === post.id && angle.sourceHash === contentHash)
      .sort(sortAngles);

    if (matchingAngles.length) {
      const mergedSource: SourceRecord = {
        redditId: post.id,
        title: post.title,
        selftext: post.selftext,
        url: post.url,
        subreddit: post.subreddit,
        author: post.author,
        created: post.created,
        contentHash,
        status: matchingAngles.some(angle => angle.status === 'ready' || angle.status === 'queued')
          ? 'banked'
          : 'exhausted',
        summary: extraction.summary,
        angleIds: uniqStrings([
          ...(existingSource?.angleIds || []),
          ...matchingAngles.map(angle => angle.id),
        ]),
        lastSeenAt: now,
        extractedAt: existingSource?.extractedAt || now,
        exhaustedAt: matchingAngles.some(angle => angle.status === 'ready' || angle.status === 'queued')
          ? undefined
          : existingSource?.exhaustedAt || now,
        lastQueuedAt: existingSource?.lastQueuedAt,
        lastPublishedAt: existingSource?.lastPublishedAt,
      };

      putSource(mergedSource);
      if (mergedSource.status === 'exhausted') {
        markUsedDirect(post.id);
      }

      return {
        source: mergedSource,
        readyAngles: matchingAngles.filter(angle => angle.status === 'ready'),
      };
    }

    const newAngles: AngleRecord[] = extraction.angles.map((angle, index) => ({
      id: `${post.id}:${contentHash.slice(0, 12)}:${index + 1}`,
      redditId: post.id,
      sourceHash: contentHash,
      sourceCreated: post.created,
      sourceTitle: post.title,
      label: angle.label,
      thesis: angle.thesis,
      hook: angle.hook,
      supportingPoints: angle.supportingPoints,
      practicalConsequence: angle.practicalConsequence,
      specificExample: angle.specificExample,
      audienceFit: angle.audienceFit,
      strength: angle.strength,
      status: 'ready',
      createdAt: now,
    }));

    for (const angle of newAngles) {
      putAngle(angle);
    }

    const nextSource: SourceRecord = {
      redditId: post.id,
      title: post.title,
      selftext: post.selftext,
      url: post.url,
      subreddit: post.subreddit,
      author: post.author,
      created: post.created,
      contentHash,
      status: newAngles.length ? 'banked' : 'exhausted',
      summary: extraction.summary,
      angleIds: uniqStrings([
        ...(existingSource?.angleIds || []),
        ...newAngles.map(angle => angle.id),
      ]),
      lastSeenAt: now,
      extractedAt: now,
      exhaustedAt: newAngles.length ? undefined : now,
      lastQueuedAt: existingSource?.lastQueuedAt,
      lastPublishedAt: existingSource?.lastPublishedAt,
    };

    putSource(nextSource);

    if (!newAngles.length) {
      markUsedDirect(post.id);
    }

    return { source: nextSource, readyAngles: newAngles };
  });
}

export function markAngleQueued(angleId: string, slotId: SlotId): AngleRecord | undefined {
  return transaction(() => {
    const now = nowIso();
    const current = getAngle(angleId);
    if (!current) return undefined;

    const nextAngle: AngleRecord = {
      ...current,
      status: 'queued',
      queuedAt: now,
      lastQueuedSlot: slotId,
      lastError: undefined,
    };
    putAngle(nextAngle);

    const source = getSource(nextAngle.redditId);
    if (source) {
      putSource({
        ...source,
        status: 'banked',
        lastQueuedAt: now,
        exhaustedAt: undefined,
        lastSeenAt: now,
      });
    }

    return nextAngle;
  });
}

export function releaseQueuedAngle(angleId: string): AngleRecord | undefined {
  return transaction(() => {
    const current = getAngle(angleId);
    if (!current) return undefined;
    if (current.status !== 'queued') return current;

    const nextAngle: AngleRecord = {
      ...current,
      status: 'ready',
      queuedAt: undefined,
      lastQueuedSlot: undefined,
    };
    putAngle(nextAngle);
    reconcileSourceStatus(nextAngle.redditId);
    return nextAngle;
  });
}

export function discardAngle(angleId: string, reason?: string): AngleRecord | undefined {
  return transaction(() => {
    const now = nowIso();
    const current = getAngle(angleId);
    if (!current) return undefined;

    const nextAngle: AngleRecord = {
      ...current,
      status: 'discarded',
      discardedAt: now,
      lastError: reason,
      lastQueuedSlot: undefined,
    };
    putAngle(nextAngle);
    reconcileSourceStatus(nextAngle.redditId);
    return nextAngle;
  });
}

export function markAnglePublished(angleId: string): AngleRecord | undefined {
  return transaction(() => {
    const now = nowIso();
    const current = getAngle(angleId);
    if (!current) return undefined;

    const nextAngle: AngleRecord = {
      ...current,
      status: 'published',
      publishedAt: now,
      lastQueuedSlot: undefined,
      lastError: undefined,
    };
    putAngle(nextAngle);

    const source = getSource(nextAngle.redditId);
    if (source) {
      putSource({
        ...source,
        lastPublishedAt: now,
        lastSeenAt: now,
      });
    }

    reconcileSourceStatus(nextAngle.redditId);
    return nextAngle;
  });
}

export function reconcileSourceStatus(redditId: string): SourceRecord | undefined {
  const source = getSource(redditId);
  if (!source) return undefined;

  const now = nowIso();
  const active = getAnglesForSource(redditId).some(angle => angle.status === 'ready' || angle.status === 'queued');
  const nextSource: SourceRecord = {
    ...source,
    status: active ? 'banked' : 'exhausted',
    exhaustedAt: active ? undefined : source.exhaustedAt || now,
    lastSeenAt: now,
  };

  putSource(nextSource);

  if (!active) {
    markUsedDirect(redditId);
  }

  return nextSource;
}

export function getMemoryStats(): MemoryStats {
  const sources = getSources();
  const angles = getAngles();

  return {
    sources: {
      total: sources.length,
      banked: sources.filter(source => source.status === 'banked').length,
      exhausted: sources.filter(source => source.status === 'exhausted').length,
    },
    angles: {
      total: angles.length,
      ready: angles.filter(angle => angle.status === 'ready').length,
      queued: angles.filter(angle => angle.status === 'queued').length,
      published: angles.filter(angle => angle.status === 'published').length,
      discarded: angles.filter(angle => angle.status === 'discarded').length,
    },
    legacyUsedIds: getUsedIds().size,
  };
}

export function getPlatformPublishStates(): PlatformPublishStateMap {
  const rows = db.prepare(`
    SELECT platform_key, payload_json FROM app_platform_state
  `).all() as Array<{ platform_key: PlatformKey; payload_json: string }>;

  const states: PlatformPublishStateMap = {};
  for (const row of rows) {
    states[row.platform_key] = parsePayload<PlatformPublishState>(row.payload_json, {});
  }
  return states;
}

export function getPlatformPublishState(platform: PlatformKey): PlatformPublishState | undefined {
  const row = db.prepare('SELECT payload_json FROM app_platform_state WHERE platform_key = ?').get(platform) as { payload_json?: string } | undefined;
  return row?.payload_json ? parsePayload<PlatformPublishState>(row.payload_json, {}) : undefined;
}

export function setPlatformPublishBlocked(
  platform: PlatformKey,
  reason: string,
  blockedUntil: string
): PlatformPublishState {
  const nextState: PlatformPublishState = {
    ...(getPlatformPublishState(platform) || {}),
    publishBlockedReason: reason,
    publishBlockedUntil: blockedUntil,
    lastFailureAt: nowIso(),
  };

  transaction(() => {
    putPlatformState(platform, nextState);
  });
  return nextState;
}

export function clearPlatformPublishBlocked(platform: PlatformKey): PlatformPublishState {
  const nextState: PlatformPublishState = {
    ...(getPlatformPublishState(platform) || {}),
    publishBlockedReason: undefined,
    publishBlockedUntil: undefined,
    lastSuccessAt: nowIso(),
  };

  transaction(() => {
    putPlatformState(platform, nextState);
  });
  return nextState;
}

export function acquireAutomationLock(lockKey: string, owner: string, ttlMs = 10 * 60 * 1000): void {
  transaction(() => {
    db.prepare('DELETE FROM app_automation_locks WHERE expires_at <= ?').run(nowIso());
    const existing = db.prepare(`
      SELECT owner, expires_at
      FROM app_automation_locks
      WHERE lock_key = ?
    `).get(lockKey) as { owner: string; expires_at: string } | undefined;

    if (existing) {
      locked('Automation lock is already held', 'AUTOMATION_LOCKED', {
        lockKey,
        owner: existing.owner,
        expiresAt: existing.expires_at,
      });
    }

    const acquiredAt = nowIso();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    db.prepare(`
      INSERT INTO app_automation_locks (lock_key, owner, acquired_at, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(lockKey, owner, acquiredAt, expiresAt);
  });
}

export function releaseAutomationLock(lockKey: string, owner: string): void {
  db.prepare('DELETE FROM app_automation_locks WHERE lock_key = ? AND owner = ?').run(lockKey, owner);
}

export async function withAutomationLock<T>(
  lockKey: string,
  owner: string,
  fn: () => Promise<T> | T,
  ttlMs = 10 * 60 * 1000
): Promise<T> {
  acquireAutomationLock(lockKey, owner, ttlMs);
  try {
    return await fn();
  } finally {
    releaseAutomationLock(lockKey, owner);
  }
}
