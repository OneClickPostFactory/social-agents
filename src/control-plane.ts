import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { badRequest, conflict, forbidden, locked, notFound, tooManyRequests, unauthorized } from './errors';

function getProjectRoot(): string {
  const parent = path.resolve(__dirname, '..');
  return path.basename(parent) === 'dist'
    ? path.resolve(parent, '..')
    : parent;
}

const DATA_DIR = process.env.APP_DATA_DIR
  ? path.resolve(process.env.APP_DATA_DIR)
  : path.join(getProjectRoot(), 'data');
const DB_FILE = path.join(DATA_DIR, 'control-plane.sqlite');
const KEY_FILE = path.join(DATA_DIR, 'control-plane.key');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export type AppRole = 'owner' | 'operator' | 'viewer';
export type BillingStatus =
  | 'setup'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'paused'
  | 'canceled'
  | 'unpaid';

export interface RuntimeSettings {
  REDDIT_USER?: string;
  REDDIT_ALLOWED_SUBS?: string[];
  REDDIT_SORT?: string;
  REDDIT_LIMIT?: number;
  OPENAI_MODEL?: string;
  AI_STYLE?: string;
  CUSTOM_PROMPT?: string;
  ENABLE_LINKEDIN?: boolean;
  ENABLE_X?: boolean;
  ENABLE_THREADS?: boolean;
  ENABLE_INSTAGRAM?: boolean;
  ENABLE_FACEBOOK?: boolean;
  META_GRAPH_VERSION?: string;
  THREADS_GRAPH_VERSION?: string;
  CLOUDINARY_FOLDER?: string;
  TIMEZONE?: string;
}

export interface RuntimeSecrets {
  OPENAI_API_KEY?: string;
  LINKEDIN_TOKEN?: string;
  LINKEDIN_PERSON_URN?: string;
  X_API_KEY?: string;
  X_API_SECRET?: string;
  X_ACCESS_TOKEN?: string;
  X_ACCESS_TOKEN_SECRET?: string;
  X_OAUTH2_ACCESS_TOKEN?: string;
  X_OAUTH2_REFRESH_TOKEN?: string;
  X_CLIENT_ID?: string;
  X_CLIENT_SECRET?: string;
  X_REDIRECT_URI?: string;
  THREADS_ACCESS_TOKEN?: string;
  THREADS_USER_ID?: string;
  META_ACCESS_TOKEN?: string;
  FACEBOOK_PAGE_ACCESS_TOKEN?: string;
  INSTAGRAM_ACCOUNT_ID?: string;
  FACEBOOK_GROUP_ID?: string;
  FACEBOOK_USER_ID?: string;
  FACEBOOK_PAGE_ID?: string;
  CLOUDINARY_CLOUD_NAME?: string;
  CLOUDINARY_API_KEY?: string;
  CLOUDINARY_API_SECRET?: string;
  CLOUDINARY_UPLOAD_PRESET?: string;
}

export interface BillingState {
  status: BillingStatus;
  trialStartedAt?: string;
  trialEndsAt?: string;
  planInterval?: 'monthly' | 'yearly';
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  stripeCheckoutSessionId?: string;
  currentPeriodEnd?: string;
  cancelAtPeriodEnd?: boolean;
  lockedReason?: string;
  updatedAt: string;
}

export interface PublicBillingState extends BillingState {
  accessActive: boolean;
  prices: {
    monthlyGbp: number;
    yearlyGbp: number;
  };
}

interface BillingStateReadOptions {
  persistNormalization?: boolean;
}

export interface AuthUser {
  id: number;
  email: string;
  role: AppRole;
  disabled: boolean;
  mfaRequired: boolean;
  mfaEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
}

export interface SessionUser {
  user: AuthUser;
  sessionId: number;
  sessionToken: string;
  csrfToken: string;
  expiresAt: string;
  mfaVerified: boolean;
}

export interface NewSession {
  token: string;
  csrfToken: string;
  user: AuthUser;
  expiresAt: string;
  mfaVerified: boolean;
}

export interface AuditLogEntry {
  id: number;
  actorUserId?: number;
  action: string;
  target: string;
  metadata: Record<string, unknown>;
  ip?: string;
  createdAt: string;
}

interface StoredUserRow {
  id: number;
  email: string;
  role: string;
  password_hash: string;
  disabled?: number | null;
  mfa_required?: number | null;
  mfa_secret_encrypted?: string | null;
  mfa_enabled_at?: string | null;
  created_at: string;
  updated_at: string;
  last_login_at?: string | null;
}

interface StoredSessionRow {
  id: number;
  user_id: number;
  token_hash: string;
  csrf_token: string;
  expires_at: string;
  mfa_verified?: number | null;
  created_at: string;
  last_seen_at: string;
  user_agent?: string | null;
  ip?: string | null;
}

interface StoredAuditRow {
  id: number;
  actor_user_id?: number | null;
  action: string;
  target: string;
  metadata_json: string;
  ip?: string | null;
  created_at: string;
}

interface StoredThrottleRow {
  scope: string;
  identifier: string;
  count: number;
  first_failed_at: string;
  last_failed_at: string;
  locked_until?: string | null;
}

interface StoredMfaEnrollmentRow {
  user_id: number;
  secret_encrypted: string;
  created_at: string;
}

interface SingletonRow {
  value: string;
}

const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS app_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    role TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT
  );

  CREATE TABLE IF NOT EXISTS app_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    csrf_token TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    user_agent TEXT,
    ip TEXT
  );

  CREATE TABLE IF NOT EXISTS app_singletons (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_user_id INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    ip TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_auth_throttle (
    scope TEXT NOT NULL,
    identifier TEXT NOT NULL,
    count INTEGER NOT NULL,
    first_failed_at TEXT NOT NULL,
    last_failed_at TEXT NOT NULL,
    locked_until TEXT,
    PRIMARY KEY (scope, identifier)
  );

  CREATE TABLE IF NOT EXISTS app_mfa_enrollment (
    user_id INTEGER PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
    secret_encrypted TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_app_sessions_token_hash ON app_sessions(token_hash);
  CREATE INDEX IF NOT EXISTS idx_app_sessions_user_id ON app_sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_app_audit_logs_created_at ON app_audit_logs(created_at DESC);
`);

function columnExists(tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.some(row => row.name === columnName);
}

function ensureColumn(tableName: string, columnName: string, sqlType: string): void {
  if (!columnExists(tableName, columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${sqlType}`);
  }
}

ensureColumn('app_users', 'disabled', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('app_users', 'mfa_required', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('app_users', 'mfa_secret_encrypted', 'TEXT');
ensureColumn('app_users', 'mfa_enabled_at', 'TEXT');
ensureColumn('app_sessions', 'mfa_verified', 'INTEGER NOT NULL DEFAULT 1');

function nowIso(): string {
  return new Date().toISOString();
}

function getTrialDays(): number {
  const parsed = Number.parseInt(process.env.TRIAL_DAYS || '7', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 7;
}

function getSessionTtlDays(): number {
  const parsed = Number.parseInt(process.env.SESSION_TTL_DAYS || '30', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
}

function getAuthAttemptWindowMinutes(): number {
  const parsed = Number.parseInt(process.env.AUTH_ATTEMPT_WINDOW_MINUTES || '15', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15;
}

function getAuthMaxAttempts(): number {
  const parsed = Number.parseInt(process.env.AUTH_MAX_ATTEMPTS || '5', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

function getAuthLockMinutes(): number {
  const parsed = Number.parseInt(process.env.AUTH_LOCK_MINUTES || '15', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15;
}

function getSingleton(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM app_singletons WHERE key = ?').get(key) as SingletonRow | undefined;
  return row?.value;
}

function setSingleton(key: string, value: string): void {
  const now = nowIso();
  db.prepare(`
    INSERT INTO app_singletons (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, now);
}

function parseJson<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function parseBooleanEnv(value: string | undefined): boolean {
  if (value === undefined || value === '') return false;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function getEncryptionKey(): Buffer {
  const envKey = process.env.APP_ENCRYPTION_KEY?.trim();
  if (envKey) {
    if (/^[A-Fa-f0-9]{64}$/.test(envKey)) {
      return Buffer.from(envKey, 'hex');
    }
    return Buffer.from(envKey, 'base64');
  }

  if (fs.existsSync(KEY_FILE)) {
    return Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'base64');
  }

  const key = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, key.toString('base64'), { encoding: 'utf8', mode: 0o600 });
  return key;
}

function encryptString(plainText: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  });
}

function decryptString(envelope: string | undefined): string {
  if (!envelope) return '';
  const parsed = parseJson<{ iv?: string; tag?: string; data?: string }>(envelope, {});
  if (!parsed.iv || !parsed.tag || !parsed.data) return '';
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(parsed.data, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 128 * 1024 * 1024,
  });
  return [
    'scrypt',
    '16384',
    '8',
    '1',
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

function verifyPassword(password: string, storedHash: string): boolean {
  const [algo, n, r, p, saltB64, derivedB64] = storedHash.split('$');
  if (algo !== 'scrypt' || !n || !r || !p || !saltB64 || !derivedB64) {
    return false;
  }

  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(derivedB64, 'base64');
  const derived = crypto.scryptSync(password, salt, expected.length, {
    N: Number.parseInt(n, 10),
    r: Number.parseInt(r, 10),
    p: Number.parseInt(p, 10),
    maxmem: 128 * 1024 * 1024,
  });

  return expected.length === derived.length
    && crypto.timingSafeEqual(expected, derived);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isPrivilegedRole(role: AppRole): boolean {
  return role === 'owner' || role === 'operator';
}

function toAuthUser(row: StoredUserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    role: row.role as AppRole,
    disabled: Boolean(row.disabled),
    mfaRequired: Boolean(row.mfa_required),
    mfaEnabled: Boolean(row.mfa_enabled_at && row.mfa_secret_encrypted),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at || undefined,
  };
}

function getUserByEmail(email: string): StoredUserRow | undefined {
  return db.prepare('SELECT * FROM app_users WHERE email = ?').get(normalizeEmail(email)) as StoredUserRow | undefined;
}

function getUserById(id: number): StoredUserRow | undefined {
  return db.prepare('SELECT * FROM app_users WHERE id = ?').get(id) as StoredUserRow | undefined;
}

function getRequiredUserById(id: number): StoredUserRow {
  const user = getUserById(id);
  if (!user) notFound('User not found', 'USER_NOT_FOUND');
  return user;
}

function getRequiredAuthUserById(id: number): AuthUser {
  return toAuthUser(getRequiredUserById(id));
}

function getThrottleRow(scope: string, identifier: string): StoredThrottleRow | undefined {
  return db.prepare(`
    SELECT * FROM app_auth_throttle
    WHERE scope = ? AND identifier = ?
  `).get(scope, identifier) as StoredThrottleRow | undefined;
}

function clearThrottle(scope: string, identifier: string): void {
  db.prepare('DELETE FROM app_auth_throttle WHERE scope = ? AND identifier = ?').run(scope, identifier);
}

function upsertThrottleFailure(scope: string, identifier: string): StoredThrottleRow {
  const current = getThrottleRow(scope, identifier);
  const now = new Date();
  const nowValue = now.toISOString();
  const windowMs = getAuthAttemptWindowMinutes() * 60 * 1000;
  const lockMs = getAuthLockMinutes() * 60 * 1000;

  let count = 1;
  let firstFailedAt = nowValue;
  let lockedUntil: string | null = null;

  if (current) {
    const firstMs = Date.parse(current.first_failed_at);
    if (Number.isFinite(firstMs) && now.getTime() - firstMs <= windowMs) {
      count = current.count + 1;
      firstFailedAt = current.first_failed_at;
    }
  }

  if (count >= getAuthMaxAttempts()) {
    lockedUntil = new Date(now.getTime() + lockMs).toISOString();
  }

  db.prepare(`
    INSERT INTO app_auth_throttle (scope, identifier, count, first_failed_at, last_failed_at, locked_until)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope, identifier)
    DO UPDATE SET
      count = excluded.count,
      first_failed_at = excluded.first_failed_at,
      last_failed_at = excluded.last_failed_at,
      locked_until = excluded.locked_until
  `).run(scope, identifier, count, firstFailedAt, nowValue, lockedUntil);

  return getThrottleRow(scope, identifier)!;
}

function assertNotThrottled(email: string, ip?: string): void {
  const rows = [
    getThrottleRow('email', normalizeEmail(email)),
    ip ? getThrottleRow('ip', ip) : undefined,
  ].filter((row): row is StoredThrottleRow => Boolean(row));

  for (const row of rows) {
    const lockedUntil = row.locked_until ? Date.parse(row.locked_until) : 0;
    if (lockedUntil > Date.now()) {
      const retryAfterSec = Math.max(1, Math.ceil((lockedUntil - Date.now()) / 1000));
      tooManyRequests('Too many authentication attempts. Try again later.', 'AUTH_THROTTLED', {
        retryAfterSec,
      });
    }
  }
}

function registerLoginFailure(email: string, ip?: string): void {
  upsertThrottleFailure('email', normalizeEmail(email));
  if (ip) {
    upsertThrottleFailure('ip', ip);
  }
}

function clearLoginFailures(email: string, ip?: string): void {
  clearThrottle('email', normalizeEmail(email));
  if (ip) {
    clearThrottle('ip', ip);
  }
}

function upsertBillingState(next: BillingState): BillingState {
  const normalized: BillingState = {
    ...next,
    updatedAt: nowIso(),
  };
  setSingleton('billing_state', JSON.stringify(normalized));
  return normalized;
}

function defaultBillingState(): BillingState {
  return {
    status: 'setup',
    updatedAt: nowIso(),
  };
}

function normalizeBillingState(state: BillingState): BillingState {
  const now = Date.now();
  if (state.status === 'trialing' && state.trialEndsAt) {
    const trialEnds = new Date(state.trialEndsAt).getTime();
    if (Number.isFinite(trialEnds) && now > trialEnds) {
      return {
        ...state,
        status: 'canceled',
        lockedReason: 'Trial expired without an active subscription',
        updatedAt: nowIso(),
      };
    }
  }
  return state;
}

export function getBillingState(): PublicBillingState {
  return readBillingState();
}

function readBillingState(options: BillingStateReadOptions = {}): PublicBillingState {
  const persistNormalization = options.persistNormalization !== false;
  const stored = parseJson<BillingState>(getSingleton('billing_state'), defaultBillingState());
  const normalized = normalizeBillingState(stored);
  if (persistNormalization && JSON.stringify(normalized) !== JSON.stringify(stored)) {
    upsertBillingState(normalized);
  }

  const accessActive = normalized.status === 'active' || normalized.status === 'trialing';
  return {
    ...normalized,
    accessActive,
    prices: {
      monthlyGbp: 8.99,
      yearlyGbp: 89,
    },
  };
}

export function getBillingStateSnapshot(): PublicBillingState {
  return readBillingState({ persistNormalization: false });
}

export function getControlPlaneDatabasePath(): string {
  return DB_FILE;
}

export function isLocalDevBillingBypassActive(): boolean {
  const nodeEnv = (process.env.NODE_ENV || 'development').trim().toLowerCase();
  return nodeEnv !== 'production'
    && parseBooleanEnv(process.env.BILLING_BYPASS_FOR_LOCAL_DEV);
}

export function canAccessAutomation(): boolean {
  if (isLocalDevBillingBypassActive()) {
    return true;
  }
  return getBillingState().accessActive;
}

export function hasUsers(): boolean {
  const row = db.prepare('SELECT COUNT(*) AS count FROM app_users').get() as { count: number };
  return row.count > 0;
}

function createSessionForUser(
  user: AuthUser,
  userAgent?: string,
  ip?: string,
  options?: {
    mfaVerified?: boolean;
  }
): NewSession {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + getSessionTtlDays() * 24 * 60 * 60 * 1000).toISOString();
  const mfaVerified = options?.mfaVerified ?? !user.mfaEnabled;

  db.prepare(`
    INSERT INTO app_sessions (
      user_id, token_hash, csrf_token, expires_at, mfa_verified, created_at, last_seen_at, user_agent, ip
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    user.id,
    hashToken(token),
    csrfToken,
    expiresAt,
    mfaVerified ? 1 : 0,
    createdAt,
    createdAt,
    userAgent || null,
    ip || null
  );

  return {
    token,
    csrfToken,
    user,
    expiresAt,
    mfaVerified,
  };
}

export function issueSessionForUser(
  userId: number,
  userAgent?: string,
  ip?: string,
  options?: {
    mfaVerified?: boolean;
    revokeExisting?: boolean;
  }
): NewSession {
  if (options?.revokeExisting) {
    destroyAllSessionsForUser(userId);
  }
  return createSessionForUser(getRequiredAuthUserById(userId), userAgent, ip, options);
}

function destroySessionById(sessionId: number): void {
  db.prepare('DELETE FROM app_sessions WHERE id = ?').run(sessionId);
}

export function getSession(token: string | undefined): SessionUser | undefined {
  if (!token) return undefined;
  const session = db.prepare('SELECT * FROM app_sessions WHERE token_hash = ?').get(hashToken(token)) as StoredSessionRow | undefined;
  if (!session) return undefined;
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    destroySessionById(session.id);
    return undefined;
  }

  db.prepare('UPDATE app_sessions SET last_seen_at = ? WHERE id = ?').run(nowIso(), session.id);

  const user = getUserById(session.user_id);
  if (!user || user.disabled) {
    destroySessionById(session.id);
    return undefined;
  }

  return {
    user: toAuthUser(user),
    sessionId: session.id,
    sessionToken: token,
    csrfToken: session.csrf_token,
    expiresAt: session.expires_at,
    mfaVerified: Boolean(session.mfa_verified),
  };
}

export function assertCsrf(session: SessionUser | undefined, providedToken: string | undefined): boolean {
  if (!session || !providedToken) return false;
  if (session.csrfToken.length !== providedToken.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(session.csrfToken, 'utf8'),
    Buffer.from(providedToken, 'utf8')
  );
}

export function destroySession(token: string | undefined): void {
  if (!token) return;
  db.prepare('DELETE FROM app_sessions WHERE token_hash = ?').run(hashToken(token));
}

export function destroyAllSessionsForUser(userId: number): void {
  db.prepare('DELETE FROM app_sessions WHERE user_id = ?').run(userId);
}

function normalizeRole(role: AppRole): AppRole {
  if (!['owner', 'operator', 'viewer'].includes(role)) {
    badRequest('Invalid role', 'INVALID_ROLE');
  }
  return role;
}

function assertPassword(password: string): void {
  if (password.length < 12) {
    badRequest('Password must be at least 12 characters', 'WEAK_PASSWORD');
  }
}

export function bootstrapOwner(email: string, password: string, userAgent?: string, ip?: string): NewSession {
  if (hasUsers()) {
    conflict('Owner already exists', 'OWNER_EXISTS');
  }

  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    badRequest('Valid email is required', 'INVALID_EMAIL');
  }
  assertPassword(password);

  const createdAt = nowIso();
  const result = db.prepare(`
    INSERT INTO app_users (
      email, role, password_hash, disabled, mfa_required, mfa_secret_encrypted, mfa_enabled_at, created_at, updated_at
    )
    VALUES (?, 'owner', ?, 0, 1, NULL, NULL, ?, ?)
  `).run(normalizedEmail, hashPassword(password), createdAt, createdAt);

  const user = getUserById(Number(result.lastInsertRowid));
  if (!user) {
    throw new Error('Failed to create owner account');
  }

  const trialStartedAt = createdAt;
  const trialEndsAt = new Date(Date.now() + getTrialDays() * 24 * 60 * 60 * 1000).toISOString();
  upsertBillingState({
    status: 'trialing',
    trialStartedAt,
    trialEndsAt,
    updatedAt: createdAt,
  });

  recordAudit('auth.bootstrap', 'system', {
    email: normalizedEmail,
    trialEndsAt,
  }, ip, user.id);

  return createSessionForUser(toAuthUser(user), userAgent, ip, { mfaVerified: true });
}

export function login(email: string, password: string, userAgent?: string, ip?: string): NewSession {
  const normalizedEmail = normalizeEmail(email);
  assertNotThrottled(normalizedEmail, ip);

  const user = getUserByEmail(normalizedEmail);
  if (!user || !verifyPassword(password, user.password_hash)) {
    registerLoginFailure(normalizedEmail, ip);
    recordAudit('auth.login.failed', 'user', { email: normalizedEmail }, ip);
    unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
  }

  if (user.disabled) {
    recordAudit('auth.login.denied_disabled', 'user', { email: normalizedEmail }, ip, user.id);
    forbidden('Account is disabled', 'ACCOUNT_DISABLED');
  }

  clearLoginFailures(normalizedEmail, ip);
  const loginAt = nowIso();
  db.prepare('UPDATE app_users SET last_login_at = ?, updated_at = ? WHERE id = ?')
    .run(loginAt, loginAt, user.id);

  recordAudit('auth.login', 'user', { email: user.email }, ip, user.id);

  const authUser = toAuthUser({
    ...user,
    last_login_at: loginAt,
  });

  return createSessionForUser(authUser, userAgent, ip, {
    mfaVerified: !authUser.mfaEnabled,
  });
}

export function logoutAllSessions(userId: number): void {
  destroyAllSessionsForUser(userId);
}

export function changePassword(userId: number, currentPassword: string, nextPassword: string): void {
  const user = getRequiredUserById(userId);
  if (!verifyPassword(currentPassword, user.password_hash)) {
    unauthorized('Current password is incorrect', 'INVALID_CURRENT_PASSWORD');
  }
  assertPassword(nextPassword);

  db.prepare('UPDATE app_users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .run(hashPassword(nextPassword), nowIso(), userId);
  destroyAllSessionsForUser(userId);
}

function base32Encode(buffer: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += alphabet[(value << (5 - bits)) & 31];
  }

  return output;
}

function base32Decode(value: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let buffer = 0;
  const bytes: number[] = [];

  for (const char of value.replace(/=+$/g, '').toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index < 0) continue;
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

function computeTotp(secret: string, counter: number, digits = 6): string {
  const key = base32Decode(secret);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (
    ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff)
  ) % 10 ** digits;

  return String(code).padStart(digits, '0');
}

function verifyTotp(secret: string, otp: string, window = 1): boolean {
  const nowCounter = Math.floor(Date.now() / 1000 / 30);
  for (let offset = -window; offset <= window; offset += 1) {
    if (computeTotp(secret, nowCounter + offset) === otp) {
      return true;
    }
  }
  return false;
}

function getPendingMfaEnrollment(userId: number): StoredMfaEnrollmentRow | undefined {
  return db.prepare('SELECT * FROM app_mfa_enrollment WHERE user_id = ?').get(userId) as StoredMfaEnrollmentRow | undefined;
}

export function getMfaStatus(userId: number): {
  required: boolean;
  enabled: boolean;
  pendingEnrollment: boolean;
} {
  const user = getRequiredUserById(userId);
  return {
    required: Boolean(user.mfa_required),
    enabled: Boolean(user.mfa_enabled_at && user.mfa_secret_encrypted),
    pendingEnrollment: Boolean(getPendingMfaEnrollment(userId)),
  };
}

export function beginMfaEnrollment(userId: number, issuer = 'Social Agent'): {
  secret: string;
  otpauthUrl: string;
} {
  const user = getRequiredUserById(userId);
  if (user.disabled) {
    forbidden('Account is disabled', 'ACCOUNT_DISABLED');
  }

  const secret = base32Encode(crypto.randomBytes(20));
  db.prepare(`
    INSERT INTO app_mfa_enrollment (user_id, secret_encrypted, created_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      secret_encrypted = excluded.secret_encrypted,
      created_at = excluded.created_at
  `).run(userId, encryptString(secret), nowIso());

  const label = encodeURIComponent(`${issuer}:${user.email}`);
  const otpauthUrl = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;
  return { secret, otpauthUrl };
}

export function enableMfa(userId: number, otp: string): void {
  const user = getRequiredUserById(userId);
  const pending = getPendingMfaEnrollment(userId);
  if (!pending) {
    badRequest('MFA enrollment has not been started', 'MFA_NOT_STARTED');
  }

  const secret = decryptString(pending.secret_encrypted);
  if (!secret || !verifyTotp(secret, otp)) {
    unauthorized('Invalid MFA code', 'INVALID_MFA_CODE');
  }

  db.prepare(`
    UPDATE app_users
    SET
      mfa_required = 1,
      mfa_secret_encrypted = ?,
      mfa_enabled_at = ?,
      updated_at = ?
    WHERE id = ?
  `).run(encryptString(secret), nowIso(), nowIso(), userId);
  db.prepare('DELETE FROM app_mfa_enrollment WHERE user_id = ?').run(userId);

  if (user.role === 'viewer') {
    db.prepare('UPDATE app_users SET mfa_required = 0 WHERE id = ?').run(userId);
  }
}

export function disableMfa(userId: number, currentPassword: string, otp?: string): void {
  const user = getRequiredUserById(userId);
  if (!verifyPassword(currentPassword, user.password_hash)) {
    unauthorized('Current password is incorrect', 'INVALID_CURRENT_PASSWORD');
  }

  if (user.mfa_secret_encrypted && user.mfa_enabled_at) {
    const secret = decryptString(user.mfa_secret_encrypted);
    if (!otp || !verifyTotp(secret, otp)) {
      unauthorized('Invalid MFA code', 'INVALID_MFA_CODE');
    }
  }

  db.prepare(`
    UPDATE app_users
    SET
      mfa_secret_encrypted = NULL,
      mfa_enabled_at = NULL,
      updated_at = ?
    WHERE id = ?
  `).run(nowIso(), userId);

  db.prepare('DELETE FROM app_mfa_enrollment WHERE user_id = ?').run(userId);
  destroyAllSessionsForUser(userId);
}

export function verifyMfaSession(sessionToken: string, otp: string, userAgent?: string, ip?: string): NewSession {
  const session = getSession(sessionToken);
  if (!session) {
    unauthorized('Authentication required', 'SESSION_NOT_FOUND');
  }

  if (session.mfaVerified) {
    return {
      token: session.sessionToken,
      csrfToken: session.csrfToken,
      user: session.user,
      expiresAt: session.expiresAt,
      mfaVerified: session.mfaVerified,
    };
  }

  const user = getRequiredUserById(session.user.id);
  const secretEncrypted = user.mfa_secret_encrypted;
  if (!secretEncrypted) {
    badRequest('MFA is not enabled for this account', 'MFA_NOT_ENABLED');
  }

  const secret = decryptString(secretEncrypted);
  if (!verifyTotp(secret, otp)) {
    unauthorized('Invalid MFA code', 'INVALID_MFA_CODE');
  }

  destroySession(sessionToken);
  return createSessionForUser(toAuthUser(user), userAgent, ip, { mfaVerified: true });
}

export function listUsers(): AuthUser[] {
  const rows = db.prepare(`
    SELECT * FROM app_users
    ORDER BY created_at ASC
  `).all() as unknown as StoredUserRow[];
  return rows.map(toAuthUser);
}

export function createUser(email: string, password: string, role: AppRole): AuthUser {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    badRequest('Valid email is required', 'INVALID_EMAIL');
  }
  assertPassword(password);
  const nextRole = normalizeRole(role);

  if (getUserByEmail(normalizedEmail)) {
    conflict('User already exists', 'USER_EXISTS');
  }

  const createdAt = nowIso();
  const result = db.prepare(`
    INSERT INTO app_users (
      email, role, password_hash, disabled, mfa_required, mfa_secret_encrypted, mfa_enabled_at, created_at, updated_at
    )
    VALUES (?, ?, ?, 0, ?, NULL, NULL, ?, ?)
  `).run(normalizedEmail, nextRole, hashPassword(password), isPrivilegedRole(nextRole) ? 1 : 0, createdAt, createdAt);

  return toAuthUser(getRequiredUserById(Number(result.lastInsertRowid)));
}

export function updateUser(userId: number, patch: {
  role?: AppRole;
  disabled?: boolean;
}): AuthUser {
  const current = getRequiredUserById(userId);
  const nextRole = patch.role ? normalizeRole(patch.role) : (current.role as AppRole);
  const disabled = patch.disabled ?? Boolean(current.disabled);
  const mfaRequired = isPrivilegedRole(nextRole) ? 1 : 0;

  db.prepare(`
    UPDATE app_users
    SET role = ?, disabled = ?, mfa_required = ?, updated_at = ?
    WHERE id = ?
  `).run(nextRole, disabled ? 1 : 0, mfaRequired, nowIso(), userId);

  if (disabled) {
    destroyAllSessionsForUser(userId);
  }

  return toAuthUser(getRequiredUserById(userId));
}

export function resetUserPassword(userId: number, nextPassword: string): void {
  getRequiredUserById(userId);
  assertPassword(nextPassword);
  db.prepare('UPDATE app_users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .run(hashPassword(nextPassword), nowIso(), userId);
  destroyAllSessionsForUser(userId);
}

export function getRuntimeSettings(): RuntimeSettings {
  return parseJson<RuntimeSettings>(getSingleton('runtime_settings'), {});
}

export function getRuntimeSecrets(): RuntimeSecrets {
  const encrypted = getSingleton('runtime_secrets');
  return parseJson<RuntimeSecrets>(decryptString(encrypted), {});
}

export function getRuntimeSecretPresence(): Record<keyof RuntimeSecrets, boolean> {
  const secrets = getRuntimeSecrets();
  return {
    OPENAI_API_KEY: Boolean(secrets.OPENAI_API_KEY),
    LINKEDIN_TOKEN: Boolean(secrets.LINKEDIN_TOKEN),
    LINKEDIN_PERSON_URN: Boolean(secrets.LINKEDIN_PERSON_URN),
    X_API_KEY: Boolean(secrets.X_API_KEY),
    X_API_SECRET: Boolean(secrets.X_API_SECRET),
    X_ACCESS_TOKEN: Boolean(secrets.X_ACCESS_TOKEN),
    X_ACCESS_TOKEN_SECRET: Boolean(secrets.X_ACCESS_TOKEN_SECRET),
    X_OAUTH2_ACCESS_TOKEN: Boolean(secrets.X_OAUTH2_ACCESS_TOKEN),
    X_OAUTH2_REFRESH_TOKEN: Boolean(secrets.X_OAUTH2_REFRESH_TOKEN),
    X_CLIENT_ID: Boolean(secrets.X_CLIENT_ID),
    X_CLIENT_SECRET: Boolean(secrets.X_CLIENT_SECRET),
    X_REDIRECT_URI: Boolean(secrets.X_REDIRECT_URI),
    THREADS_ACCESS_TOKEN: Boolean(secrets.THREADS_ACCESS_TOKEN),
    THREADS_USER_ID: Boolean(secrets.THREADS_USER_ID),
    META_ACCESS_TOKEN: Boolean(secrets.META_ACCESS_TOKEN),
    FACEBOOK_PAGE_ACCESS_TOKEN: Boolean(secrets.FACEBOOK_PAGE_ACCESS_TOKEN),
    INSTAGRAM_ACCOUNT_ID: Boolean(secrets.INSTAGRAM_ACCOUNT_ID),
    FACEBOOK_GROUP_ID: Boolean(secrets.FACEBOOK_GROUP_ID),
    FACEBOOK_USER_ID: Boolean(secrets.FACEBOOK_USER_ID),
    FACEBOOK_PAGE_ID: Boolean(secrets.FACEBOOK_PAGE_ID),
    CLOUDINARY_CLOUD_NAME: Boolean(secrets.CLOUDINARY_CLOUD_NAME),
    CLOUDINARY_API_KEY: Boolean(secrets.CLOUDINARY_API_KEY),
    CLOUDINARY_API_SECRET: Boolean(secrets.CLOUDINARY_API_SECRET),
    CLOUDINARY_UPLOAD_PRESET: Boolean(secrets.CLOUDINARY_UPLOAD_PRESET),
  };
}

function sanitizeRuntimeSettingsPatch(patch: Partial<RuntimeSettings>): Partial<RuntimeSettings> {
  const next: Partial<RuntimeSettings> = {};

  if (typeof patch.REDDIT_USER === 'string') next.REDDIT_USER = patch.REDDIT_USER.trim();
  if (Array.isArray(patch.REDDIT_ALLOWED_SUBS)) {
    next.REDDIT_ALLOWED_SUBS = patch.REDDIT_ALLOWED_SUBS.map(value => String(value).trim().toLowerCase()).filter(Boolean);
  }
  if (typeof patch.REDDIT_SORT === 'string') next.REDDIT_SORT = patch.REDDIT_SORT.trim() || 'new';
  if (typeof patch.REDDIT_LIMIT === 'number' && Number.isFinite(patch.REDDIT_LIMIT)) {
    next.REDDIT_LIMIT = Math.max(1, Math.min(100, Math.round(patch.REDDIT_LIMIT)));
  }
  if (typeof patch.OPENAI_MODEL === 'string') next.OPENAI_MODEL = patch.OPENAI_MODEL.trim();
  if (typeof patch.AI_STYLE === 'string') next.AI_STYLE = patch.AI_STYLE.trim();
  if (typeof patch.CUSTOM_PROMPT === 'string') next.CUSTOM_PROMPT = patch.CUSTOM_PROMPT;
  if (typeof patch.ENABLE_LINKEDIN === 'boolean') next.ENABLE_LINKEDIN = patch.ENABLE_LINKEDIN;
  if (typeof patch.ENABLE_X === 'boolean') next.ENABLE_X = patch.ENABLE_X;
  if (typeof patch.ENABLE_THREADS === 'boolean') next.ENABLE_THREADS = patch.ENABLE_THREADS;
  if (typeof patch.ENABLE_INSTAGRAM === 'boolean') next.ENABLE_INSTAGRAM = patch.ENABLE_INSTAGRAM;
  if (typeof patch.ENABLE_FACEBOOK === 'boolean') next.ENABLE_FACEBOOK = patch.ENABLE_FACEBOOK;
  if (typeof patch.META_GRAPH_VERSION === 'string') next.META_GRAPH_VERSION = patch.META_GRAPH_VERSION.trim();
  if (typeof patch.THREADS_GRAPH_VERSION === 'string') next.THREADS_GRAPH_VERSION = patch.THREADS_GRAPH_VERSION.trim();
  if (typeof patch.CLOUDINARY_FOLDER === 'string') next.CLOUDINARY_FOLDER = patch.CLOUDINARY_FOLDER.trim();
  if (typeof patch.TIMEZONE === 'string') next.TIMEZONE = patch.TIMEZONE.trim();

  return next;
}

export function updateRuntimeSettings(patch: Partial<RuntimeSettings>): RuntimeSettings {
  const current = getRuntimeSettings();
  const next = {
    ...current,
    ...sanitizeRuntimeSettingsPatch(patch),
  };
  setSingleton('runtime_settings', JSON.stringify(next));
  return next;
}

export function updateRuntimeSecrets(patch: Partial<Record<keyof RuntimeSecrets, string | null>>): RuntimeSecrets {
  const current = getRuntimeSecrets();
  const next: RuntimeSecrets = { ...current };

  for (const [key, value] of Object.entries(patch) as Array<[keyof RuntimeSecrets, string | null]>) {
    if (value === null || value === '') {
      delete next[key];
      continue;
    }
    if (typeof value === 'string') {
      next[key] = value.trim();
    }
  }

  setSingleton('runtime_secrets', encryptString(JSON.stringify(next)));
  return next;
}

export function getStoredRuntimeConfigPatch(): Record<string, unknown> {
  return {
    ...getRuntimeSettings(),
    ...getRuntimeSecrets(),
  };
}

export function getSetupStatus(): {
  initialized: boolean;
  hasOwner: boolean;
  billing: PublicBillingState;
  secretStorageReady: boolean;
} {
  const hasOwner = hasUsers();
  return {
    initialized: hasOwner,
    hasOwner,
    billing: getBillingState(),
    secretStorageReady: true,
  };
}

export function updateBillingFromStripeSubscription(subscription: Record<string, unknown>): PublicBillingState {
  const statusValue = String(subscription.status || '').trim();
  const mappedStatus: BillingStatus = (
    ['trialing', 'active', 'past_due', 'paused', 'canceled', 'unpaid'].includes(statusValue)
      ? statusValue
      : 'setup'
  ) as BillingStatus;

  const trialEndsAt = typeof subscription.trial_end === 'number'
    ? new Date(subscription.trial_end * 1000).toISOString()
    : undefined;
  const currentPeriodEnd = typeof subscription.current_period_end === 'number'
    ? new Date(subscription.current_period_end * 1000).toISOString()
    : undefined;

  const next = upsertBillingState({
    ...getBillingState(),
    status: mappedStatus,
    trialEndsAt,
    currentPeriodEnd,
    stripeCustomerId: typeof subscription.customer === 'string' ? subscription.customer : undefined,
    stripeSubscriptionId: typeof subscription.id === 'string' ? subscription.id : undefined,
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
    lockedReason: mappedStatus === 'active' || mappedStatus === 'trialing'
      ? undefined
      : `Subscription is ${mappedStatus}`,
    updatedAt: nowIso(),
  });

  return {
    ...next,
    accessActive: next.status === 'active' || next.status === 'trialing',
    prices: {
      monthlyGbp: 8.99,
      yearlyGbp: 89,
    },
  };
}

export function updateBillingCheckoutState(patch: Partial<BillingState>): PublicBillingState {
  const next = upsertBillingState({
    ...getBillingState(),
    ...patch,
    updatedAt: nowIso(),
  });

  return {
    ...next,
    accessActive: next.status === 'active' || next.status === 'trialing',
    prices: {
      monthlyGbp: 8.99,
      yearlyGbp: 89,
    },
  };
}

export function recordAudit(
  action: string,
  target: string,
  metadata: Record<string, unknown> = {},
  ip?: string,
  actorUserId?: number
): void {
  db.prepare(`
    INSERT INTO app_audit_logs (actor_user_id, action, target, metadata_json, ip, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    actorUserId || null,
    action,
    target,
    JSON.stringify(metadata),
    ip || null,
    nowIso()
  );
}

export function getAuditLogs(limit = 100): AuditLogEntry[] {
  const rows = db.prepare(`
    SELECT * FROM app_audit_logs
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit) as unknown as StoredAuditRow[];

  return rows.map(row => ({
    id: row.id,
    actorUserId: row.actor_user_id || undefined,
    action: row.action,
    target: row.target,
    metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
    ip: row.ip || undefined,
    createdAt: row.created_at,
  }));
}

export function getDbHealth(): { ok: boolean } {
  db.prepare('SELECT 1').get();
  return { ok: true };
}
