import * as nodeCrypto from 'node:crypto';
import config from '../config';
import {
  isSupabaseWorkerConfigured,
  supabaseInsert,
  supabaseSelect,
  supabaseUpdate,
} from './supabase-client';
import { processTrustedConnectorSourceRecords } from './browser-collector-ingest';

type JsonRecord = Record<string, unknown>;

export interface RedditConnectorEnv {
  REDDIT_CONNECTOR_ENABLED?: string;
  REDDIT_CONNECTOR_MAX_POSTS_PER_RUN?: string;
  REDDIT_CONNECTOR_PAIRING_TTL_SECONDS?: string;
  REDDIT_CONNECTOR_PAIRING_SECRET?: string;
  APP_ALLOWED_ORIGINS?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_SECRET_KEY?: string;
  SERVICE_ROLE_KEY?: string;
}

interface PairingCodeRow {
  id: string;
  user_id: string;
  code_hash: string;
  expires_at: string;
  used_at?: string | null;
}

interface ConnectorDeviceRow {
  id: string;
  user_id: string;
  token_hash: string;
  label?: string | null;
  status?: string | null;
  paired_at?: string | null;
  last_seen_at?: string | null;
  last_collection_at?: string | null;
  last_error_code?: string | null;
  last_error_message?: string | null;
  revoked_at?: string | null;
}

interface ConnectorSourceRow {
  id: string;
  user_id: string;
  kind?: string | null;
  value?: string | null;
  enabled?: boolean | null;
  provider?: string | null;
  source_scope?: string | null;
  target_author?: string | null;
  health_status?: string | null;
  allowed_subreddits?: string[] | null;
}

interface ConnectorSourceRecordRow {
  reddit_post_id?: string | null;
  subreddit?: string | null;
}

export async function handleRedditConnectorRequest(
  request: Request,
  env: RedditConnectorEnv = process.env
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return withCors(request, env, json({ ok: true }));
  }

  if (!isConnectorEnabled(env)) {
    return withCors(request, env, json({
      error: 'reddit_connector_disabled',
      message: 'The user-installed Reddit Connector is not enabled on this backend.',
    }, 403));
  }

  if (!isSupabaseWorkerConfigured()) {
    return withCors(request, env, json({
      error: 'supabase_not_configured',
      message: 'Connector backend storage is not configured.',
    }, 503));
  }

  try {
    if (request.method === 'POST' && url.pathname === '/api/connectors/reddit/pairing-code') {
      const userId = await requireSupabaseUserId(request);
      return withCors(request, env, json(await createPairingCode(userId, env)));
    }

    if (request.method === 'POST' && url.pathname === '/api/connectors/reddit/pair') {
      const body = await readJson(request);
      return withCors(request, env, json(await pairConnector(body, env), 201));
    }

    if (request.method === 'GET' && url.pathname === '/api/connectors/reddit/status') {
      const connector = await connectorFromRequest(request, env).catch(() => null);
      if (connector) {
        await touchDevice(connector.id);
        return withCors(request, env, json(safeDeviceStatus(connector)));
      }
      const userId = await requireSupabaseUserId(request);
      return withCors(request, env, json(await userConnectorStatus(userId)));
    }

    if (request.method === 'POST' && url.pathname === '/api/connectors/reddit/disconnect') {
      const connector = await connectorFromRequest(request, env).catch(() => null);
      if (connector) {
        await revokeDevice(connector.id, connector.user_id);
        return withCors(request, env, json({ status: 'disconnected' }));
      }
      const userId = await requireSupabaseUserId(request);
      await revokeUserDevices(userId);
      return withCors(request, env, json({ status: 'disconnected' }));
    }

    if (request.method === 'GET' && url.pathname === '/api/connectors/reddit/sources') {
      const connector = await requireConnector(request, env);
      await touchDevice(connector.id);
      const sourceContract = await connectorSources(connector.user_id, env);
      return withCors(request, env, json(
        sourceContract,
        sourceContract.status === 'reddit_author_filter_required' ? 409 : 200
      ));
    }

    if (request.method === 'POST' && url.pathname === '/api/connectors/reddit/source-records') {
      const connector = await requireConnector(request, env);
      const rawBody = await request.text();
      const result = await processTrustedConnectorSourceRecords(
        rawBody,
        connector.user_id,
        connectorMaxPosts(env)
      );
      await updateCollectionStatus(connector.id, connector.user_id, result.status < 400 ? null : String(result.body.error || result.body.reason || 'ingest_failed'));
      return withCors(request, env, json(result.body, result.status));
    }

    return withCors(request, env, json({ error: 'not_found' }, 404));
  } catch (error) {
    const failure = publicConnectorError(error);
    return withCors(request, env, json({
      error: failure.code,
      message: failure.message,
    }, failure.status));
  }
}

async function createPairingCode(userId: string, env: RedditConnectorEnv): Promise<JsonRecord> {
  const code = randomPairingCode();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + pairingTtlMs(env)).toISOString();
  await supabaseInsert('reddit_connector_pairing_codes', {
    user_id: userId,
    code_hash: await hashSecret(code, pairingPepper(env)),
    expires_at: expiresAt,
  });

  return {
    pairing_code: code,
    expires_at: expiresAt,
    pairing_ttl_seconds: Math.floor(pairingTtlMs(env) / 1000),
  };
}

async function pairConnector(body: JsonRecord, env: RedditConnectorEnv): Promise<JsonRecord> {
  const code = readString(body, 'pairing_code') || readString(body, 'code');
  if (!code) throw httpError(400, 'pairing_code_required', 'A pairing code is required.');

  const codeHash = await hashSecret(code, pairingPepper(env));
  const rows = await supabaseSelect<PairingCodeRow>('reddit_connector_pairing_codes', {
    select: 'id,user_id,code_hash,expires_at,used_at',
    filters: [
      { column: 'code_hash', operator: 'eq', value: codeHash },
      { column: 'used_at', operator: 'is', value: null },
      { column: 'expires_at', operator: 'gte', value: new Date().toISOString() },
    ],
    limit: 1,
  });
  const pairing = rows[0];
  if (!pairing) throw httpError(401, 'invalid_or_expired_pairing_code', 'Pairing code is invalid or expired.');

  const claimed = await supabaseUpdate<PairingCodeRow>('reddit_connector_pairing_codes', {
    used_at: new Date().toISOString(),
  }, {
    filters: [
      { column: 'id', operator: 'eq', value: pairing.id },
      { column: 'used_at', operator: 'is', value: null },
      { column: 'expires_at', operator: 'gte', value: new Date().toISOString() },
    ],
    returning: true,
  });
  if (!claimed[0]) throw httpError(401, 'invalid_or_expired_pairing_code', 'Pairing code is invalid or expired.');

  const deviceToken = `ocrc_${nodeCrypto.randomBytes(32).toString('base64url')}`;
  const tokenHash = await hashSecret(deviceToken, devicePepper(env));
  const label = safeLabel(readString(body, 'device_label') || readString(body, 'label') || 'Reddit Connector');
  const inserted = await supabaseInsert<{ id: string }>('reddit_connector_devices', {
    user_id: claimed[0].user_id,
    token_hash: tokenHash,
    label,
    status: 'paired',
    paired_at: new Date().toISOString(),
  }, true);

  return {
    status: 'paired',
    device_id: inserted[0]?.id || null,
    connector_device_token: deviceToken,
    token_returned_once: true,
  };
}

async function userConnectorStatus(userId: string): Promise<JsonRecord> {
  const devices = await supabaseSelect<ConnectorDeviceRow>('reddit_connector_devices', {
    select: 'id,user_id,label,status,paired_at,last_seen_at,last_collection_at,last_error_code,last_error_message,revoked_at',
    filters: [
      { column: 'user_id', operator: 'eq', value: userId },
    ],
    order: 'created_at.desc',
    limit: 10,
  });

  const active = devices.find(device => !device.revoked_at) || null;
  return {
    status: active ? 'paired' : 'not_installed',
    device: active ? safeDeviceStatus(active) : null,
    devices: devices.map(safeDeviceStatus),
  };
}

async function requireConnector(request: Request, env: RedditConnectorEnv): Promise<ConnectorDeviceRow> {
  const connector = await connectorFromRequest(request, env);
  if (!connector) throw httpError(401, 'connector_token_invalid', 'Connector token is invalid or revoked.');
  return connector;
}

async function connectorFromRequest(request: Request, env: RedditConnectorEnv): Promise<ConnectorDeviceRow | null> {
  const token = connectorTokenFromRequest(request);
  if (!token) throw httpError(401, 'connector_token_required', 'Connector token is required.');
  const rows = await supabaseSelect<ConnectorDeviceRow>('reddit_connector_devices', {
    select: 'id,user_id,token_hash,label,status,paired_at,last_seen_at,last_collection_at,last_error_code,last_error_message,revoked_at',
    filters: [
      { column: 'token_hash', operator: 'eq', value: await hashSecret(token, devicePepper(env)) },
      { column: 'revoked_at', operator: 'is', value: null },
    ],
    limit: 1,
  });
  return rows[0] || null;
}

function connectorTokenFromRequest(request: Request): string {
  const explicit = request.headers.get('x-oneclick-connector-token') || '';
  if (explicit.trim()) return explicit.trim();
  const auth = request.headers.get('authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

async function connectorSources(userId: string, env: RedditConnectorEnv): Promise<JsonRecord> {
  const author = await enabledAuthorFilter(userId);
  const subredditSources = await enabledSubredditSources(userId, env);
  const existingRedditPostIds = await existingRedditPostIdsForSources(userId, subredditSources);
  if (!author) {
    return {
      status: 'reddit_author_filter_required',
      error: 'reddit_author_filter_required',
      message: 'Add an enabled Reddit username source before collecting subreddit posts.',
      author_filter: null,
      subreddit_sources: subredditSources,
      sources: subredditSources,
      existing_reddit_post_ids: existingRedditPostIds,
    };
  }

  return {
    status: 'ok',
    author_filter: author,
    subreddit_sources: subredditSources,
    sources: subredditSources,
    existing_reddit_post_ids: existingRedditPostIds,
  };
}

async function existingRedditPostIdsForSources(userId: string, sources: JsonRecord[]): Promise<string[]> {
  const rows = await supabaseSelect<ConnectorSourceRecordRow>('source_records', {
    select: 'reddit_post_id,subreddit',
    filters: [
      { column: 'user_id', operator: 'eq', value: userId },
      { column: 'origin', operator: 'eq', value: 'authenticated_browser' },
    ],
    order: 'created_at.desc',
    limit: 500,
  });
  const enabledSubreddits = new Set(sources
    .map(source => normalizeSubreddit(String(source.subreddit || source.source_value || '')))
    .filter(Boolean));
  return knownRedditPostIds(rows, enabledSubreddits);
}

function knownRedditPostIds(rows: ConnectorSourceRecordRow[], enabledSubreddits: Set<string>): string[] {
  return [...new Set(rows
    .filter(row => enabledSubreddits.has(normalizeSubreddit(String(row.subreddit || ''))))
    .map(row => normalizeRedditPostId(String(row.reddit_post_id || '')))
    .filter(Boolean))];
}

function normalizeRedditPostId(value: string): string {
  const match = value.trim().toLowerCase().match(/^(?:t3_)?([a-z0-9]+)$/);
  return match ? 't3_' + match[1] : '';
}

async function enabledAuthorFilter(userId: string): Promise<JsonRecord | null> {
  const rows = await supabaseSelect<ConnectorSourceRow>('user_sources', {
    select: 'id,user_id,kind,value,enabled,provider,source_scope,target_author,health_status',
    filters: [
      { column: 'user_id', operator: 'eq', value: userId },
      { column: 'provider', operator: 'eq', value: 'reddit' },
      { column: 'enabled', operator: 'eq', value: true },
    ],
    order: 'created_at.desc',
    limit: 50,
  });

  for (const row of rows) {
    if (row.health_status && row.health_status !== 'healthy') continue;
    if (row.kind !== 'reddit_user' && row.source_scope !== 'reddit_user') continue;
    const username = normalizeRedditUsername(String(row.target_author || row.value || ''));
    if (username) {
      return {
        source_id: row.id,
        username,
      };
    }
  }

  return null;
}

async function enabledSubredditSources(userId: string, env: RedditConnectorEnv): Promise<JsonRecord[]> {
  const rows = await supabaseSelect<ConnectorSourceRow>('user_sources', {
    select: 'id,user_id,kind,value,enabled,provider,source_scope,health_status,allowed_subreddits',
    filters: [
      { column: 'user_id', operator: 'eq', value: userId },
      { column: 'provider', operator: 'eq', value: 'reddit' },
      { column: 'kind', operator: 'eq', value: 'subreddit' },
      { column: 'source_scope', operator: 'eq', value: 'subreddit' },
      { column: 'enabled', operator: 'eq', value: true },
    ],
    order: 'created_at.desc',
    limit: 50,
  });

  return rows
    .filter(row => !row.health_status || row.health_status === 'healthy')
    .map(row => ({
      source_id: row.id,
      source_type: 'subreddit',
      source_value: normalizeSubreddit(String(row.value || '')),
      subreddit: normalizeSubreddit(String(row.value || '')),
      enabled: true,
      max_posts_per_run: connectorMaxPosts(env),
      last_collected_at: null,
      source_url: `https://www.reddit.com/r/${encodeURIComponent(normalizeSubreddit(String(row.value || '')))}/new/`,
    }))
    .filter(source => source.source_value);
}

async function requireSupabaseUserId(request: Request): Promise<string> {
  const auth = request.headers.get('authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) throw httpError(401, 'supabase_bearer_required', 'Sign in before managing the connector.');

  const response = await fetch(`${config.SUPABASE_URL.replace(/\/+$/, '')}/auth/v1/user`, {
    headers: {
      apikey: config.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${match[1]}`,
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(config.HTTP_TIMEOUT_MS),
  });
  if (!response.ok) throw httpError(401, 'supabase_session_invalid', 'Sign in before managing the connector.');

  const body = await response.json() as { id?: unknown; sub?: unknown };
  const userId = typeof body.id === 'string' ? body.id : typeof body.sub === 'string' ? body.sub : '';
  if (!userId) throw httpError(401, 'supabase_user_missing', 'Authenticated user could not be resolved.');
  return userId;
}

async function touchDevice(deviceId: string): Promise<void> {
  await supabaseUpdate('reddit_connector_devices', {
    last_seen_at: new Date().toISOString(),
    status: 'paired',
  }, {
    filters: [{ column: 'id', operator: 'eq', value: deviceId }],
  });
}

async function revokeDevice(deviceId: string, userId: string): Promise<void> {
  await supabaseUpdate('reddit_connector_devices', {
    revoked_at: new Date().toISOString(),
    status: 'revoked',
  }, {
    filters: [
      { column: 'id', operator: 'eq', value: deviceId },
      { column: 'user_id', operator: 'eq', value: userId },
    ],
  });
}

async function revokeUserDevices(userId: string): Promise<void> {
  await supabaseUpdate('reddit_connector_devices', {
    revoked_at: new Date().toISOString(),
    status: 'revoked',
  }, {
    filters: [
      { column: 'user_id', operator: 'eq', value: userId },
      { column: 'revoked_at', operator: 'is', value: null },
    ],
  });
}

async function updateCollectionStatus(deviceId: string, userId: string, errorCode: string | null): Promise<void> {
  await supabaseUpdate('reddit_connector_devices', {
    last_seen_at: new Date().toISOString(),
    last_collection_at: errorCode ? null : new Date().toISOString(),
    last_error_code: errorCode,
    last_error_message: null,
    status: errorCode ? 'error' : 'connected_to_reddit',
  }, {
    filters: [
      { column: 'id', operator: 'eq', value: deviceId },
      { column: 'user_id', operator: 'eq', value: userId },
    ],
  });
}

function safeDeviceStatus(device: ConnectorDeviceRow): JsonRecord {
  return {
    id: device.id,
    label: device.label || 'Reddit Connector',
    status: device.revoked_at ? 'revoked' : (device.status || 'paired'),
    paired_at: device.paired_at || null,
    last_seen_at: device.last_seen_at || null,
    last_collection_at: device.last_collection_at || null,
    last_error_code: device.last_error_code || null,
    last_error_message: device.last_error_message || null,
    revoked_at: device.revoked_at || null,
  };
}

async function readJson(request: Request): Promise<JsonRecord> {
  const text = await request.text();
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw httpError(400, 'invalid_json', 'Request body must be a JSON object.');
  }
  return parsed as JsonRecord;
}

function isConnectorEnabled(env: RedditConnectorEnv): boolean {
  return /^(1|true|yes|on)$/i.test(String(env.REDDIT_CONNECTOR_ENABLED || 'true').trim());
}

function connectorMaxPosts(env: RedditConnectorEnv): number {
  const parsed = Number.parseInt(String(env.REDDIT_CONNECTOR_MAX_POSTS_PER_RUN || '2'), 10);
  return Math.max(1, Math.min(Number.isFinite(parsed) ? parsed : 2, 5));
}

function pairingTtlMs(env: RedditConnectorEnv): number {
  const parsed = Number.parseInt(String(env.REDDIT_CONNECTOR_PAIRING_TTL_SECONDS || '600'), 10);
  return Math.max(60, Math.min(Number.isFinite(parsed) ? parsed : 600, 1800)) * 1000;
}

function pairingPepper(env: RedditConnectorEnv): string {
  return env.REDDIT_CONNECTOR_PAIRING_SECRET || config.CREDENTIAL_ENCRYPTION_KEY || '';
}

function devicePepper(env: RedditConnectorEnv): string {
  return env.REDDIT_CONNECTOR_PAIRING_SECRET || config.CREDENTIAL_ENCRYPTION_KEY || '';
}

async function hashSecret(value: string, pepper: string): Promise<string> {
  return nodeCrypto.createHash('sha256').update(`${pepper}:${value}`).digest('hex');
}

function randomPairingCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = nodeCrypto.randomBytes(8);
  return [...bytes].map(byte => alphabet[byte % alphabet.length]).join('');
}

function normalizeSubreddit(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\/(?:www\.)?reddit\.com\/r\//i, '')
    .replace(/^\/?r\//i, '')
    .split(/[/?#|]/)[0]
    .trim()
    .toLowerCase();
}

function normalizeRedditUsername(value: string): string {
  const raw = value.trim();
  if (!raw) return '';
  const pathMatch = raw.match(/\/(?:user|u)\/([^/?#]+)/i);
  const candidate = pathMatch ? pathMatch[1] : raw.replace(/^u\//i, '');
  const cleaned = (candidate.split(/[?#|]/)[0] || '').replace(/^\/+|\/+$/g, '').trim();
  return /^[A-Za-z0-9_-]{1,20}$/.test(cleaned) ? cleaned : '';
}

function safeLabel(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Reddit Connector';
}

function readString(record: JsonRecord, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value.trim() : '';
}

function withCors(request: Request, env: RedditConnectorEnv, response: Response): Response {
  const origin = request.headers.get('origin') || '';
  const allowed = allowedOrigins(env);
  const headers = new Headers(response.headers);
  if (origin && allowed.includes(origin)) {
    headers.set('access-control-allow-origin', origin);
    headers.set('vary', 'Origin');
    headers.set('access-control-allow-headers', 'authorization,content-type,x-oneclick-connector-token');
    headers.set('access-control-allow-methods', 'GET,POST,OPTIONS');
  }
  return new Response(response.body, { status: response.status, headers });
}

export const redditConnectorTest = {
  knownRedditPostIds,
  normalizeRedditPostId,
};

function allowedOrigins(env: RedditConnectorEnv): string[] {
  return String(env.APP_ALLOWED_ORIGINS || process.env.APP_ALLOWED_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function httpError(status: number, code: string, message: string): Error & { status?: number; code?: string } {
  const error = new Error(message) as Error & { status?: number; code?: string };
  error.status = status;
  error.code = code;
  return error;
}

function publicConnectorError(error: unknown): { status: number; code: string; message: string } {
  if (error && typeof error === 'object' && 'status' in error && 'code' in error) {
    const typed = error as { status?: unknown; code?: unknown; message?: unknown };
    return {
      status: typeof typed.status === 'number' ? typed.status : 500,
      code: typeof typed.code === 'string' ? typed.code : 'connector_error',
      message: typeof typed.message === 'string' ? typed.message : 'Connector request failed.',
    };
  }
  return {
    status: 500,
    code: 'connector_error',
    message: 'Connector request failed safely.',
  };
}
