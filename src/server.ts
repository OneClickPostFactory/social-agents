import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import config, { reloadRuntimeConfigFromStorage, validateProductionConfig } from '../config';

import * as store from './store';
import * as logger from './logger';
import * as x from './x';

import {
  assertCsrf,
  beginMfaEnrollment,
  bootstrapOwner,
  changePassword,
  createUser,
  destroySession,
  disableMfa,
  enableMfa,
  getAuditLogs,
  getBillingStateSnapshot,
  getControlPlaneDatabasePath,
  getBillingState,
  getDbHealth,
  getMfaStatus,
  getRuntimeSecretPresence,
  getRuntimeSettings,
  getSession,
  getSetupStatus,
  issueSessionForUser,
  listUsers,
  isLocalDevBillingBypassActive,
  login,
  logoutAllSessions,
  recordAudit,
  resetUserPassword,
  updateBillingCheckoutState,
  updateBillingFromStripeSubscription,
  updateRuntimeSecrets,
  updateRuntimeSettings,
  updateUser,
  verifyMfaSession,
} from './control-plane';
import { runFetch, runPostAll, runPostSlot, runReleaseSlot, runUpdateSlot } from './automation-service';
import { getAutomationGate, getRuntimeReadiness } from './runtime-policy';
import {
  asObject,
  optionalObject,
  parseAuthCredentials,
  parseCheckoutInterval,
  parsePasswordChange,
  parseSettingsPayload,
  parseRuntimeSettingsPatch,
  parseSecretsPayload,
  parseSlotId,
  parseSlotUpdates,
  parseTotp,
  parseUserCreate,
  parseUserPasswordReset,
  parseUserUpdate,
} from './validators';
import { HttpError, badRequest, conflict, forbidden, isHttpError, notFound, unauthorized } from './errors';

import type { QueueItem, Slot } from './types';
import type { AppRole, AuthUser, SessionUser } from './control-plane';

type RequestBody = Record<string, unknown>;
type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  context: RequestContext
) => void | Promise<void>;

interface RequestContext {
  requestId: string;
  body: RequestBody;
  rawBody: string;
  cookies: Record<string, string>;
  origin?: string;
  ip?: string;
  user?: AuthUser;
  session?: SessionUser;
}

interface RouteDef {
  method: string;
  path: string;
  auth?: boolean;
  roles?: AppRole[];
  csrf?: boolean;
  billing?: 'automation';
  allowPendingMfa?: boolean;
  handler: RouteHandler;
}

const PORT = config.GUI_PORT;
const MAX_BODY_BYTES = Number.parseInt(process.env.MAX_BODY_BYTES || `${1024 * 1024}`, 10);
const ALLOWED_ORIGINS = (process.env.APP_ALLOWED_ORIGINS || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);
const COOKIE_SECURE = parseBooleanEnv(
  process.env.COOKIE_SECURE,
  process.env.NODE_ENV === 'production'
);
const COOKIE_SAME_SITE = (
  process.env.COOKIE_SAME_SITE
  || (ALLOWED_ORIGINS.length && COOKIE_SECURE ? 'None' : 'Lax')
).trim();
const SESSION_COOKIE_NAME = COOKIE_SECURE ? '__Host-social_agent_session' : 'social_agent_session';
const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_PRICE_MONTHLY_GBP = process.env.STRIPE_PRICE_MONTHLY_GBP || '';
const STRIPE_PRICE_YEARLY_GBP = process.env.STRIPE_PRICE_YEARLY_GBP || '';

const pendingXOAuth = new Map<string, { codeVerifier: string; createdAt: number }>();

const SLOTS: Slot[] = [
  { id: 's1', label: '5:00 AM', desc: 'Early risers' },
  { id: 's2', label: '7:00 AM', desc: 'Morning commute' },
  { id: 's3', label: '12:00 PM', desc: 'Lunch break' },
  { id: 's4', label: '3:00 PM', desc: 'Afternoon peak' },
];

let activeServer: http.Server | undefined;

function getRuntimeRoot(): string {
  return path.resolve(__dirname, '..');
}

function getProjectRoot(): string {
  const runtimeRoot = getRuntimeRoot();
  return path.basename(runtimeRoot) === 'dist'
    ? path.resolve(runtimeRoot, '..')
    : runtimeRoot;
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function isProductionRuntime(): boolean {
  return (process.env.NODE_ENV || config.NODE_ENV || 'development').trim().toLowerCase() === 'production';
}

function isLoopbackOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return parsed.hostname === 'localhost'
      || parsed.hostname === '127.0.0.1'
      || parsed.hostname === '[::1]'
      || parsed.hostname === '::1';
  } catch {
    return false;
  }
}

function applySecurityHeaders(
  res: http.ServerResponse,
  requestId: string,
  contentType?: string
): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'interest-cohort=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('X-Request-Id', requestId);
  if (COOKIE_SECURE) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  if (contentType) {
    res.setHeader('Content-Type', contentType);
  }
}

function json(
  res: http.ServerResponse,
  data: unknown,
  requestId: string,
  status = 200,
  origin?: string
): void {
  applyCorsHeaders(res, origin);
  applySecurityHeaders(res, requestId, 'application/json');
  res.writeHead(status);
  res.end(JSON.stringify(data));
}

function jsonErr(
  res: http.ServerResponse,
  requestId: string,
  message: string,
  status = 500,
  origin?: string,
  extras?: Record<string, unknown>
): void {
  json(res, { error: message, requestId, ...(extras || {}) }, requestId, status, origin);
}

function html(
  res: http.ServerResponse,
  body: string,
  requestId: string,
  status = 200
): void {
  applySecurityHeaders(res, requestId, 'text/html; charset=utf-8');
  res.writeHead(status);
  res.end(body);
}

function parseCookies(req: http.IncomingMessage): Record<string, string> {
  const raw = req.headers.cookie;
  if (!raw) return {};

  const cookies: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const [key, ...valueParts] = part.trim().split('=');
    if (!key) continue;
    cookies[key] = decodeURIComponent(valueParts.join('=') || '');
  }
  return cookies;
}

function getRequestOrigin(req: http.IncomingMessage): string | undefined {
  const origin = req.headers.origin;
  return typeof origin === 'string' ? origin : undefined;
}

function getAllowedOrigin(origin: string | undefined, pathname: string): string | undefined {
  if (!origin) return undefined;
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  if (!isProductionRuntime() && pathname === '/api/dev/runtime-identity' && isLoopbackOrigin(origin)) {
    return origin;
  }
  return undefined;
}

function applyCorsHeaders(res: http.ServerResponse, origin?: string): void {
  if (!origin) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Vary', 'Origin');
}

function buildSessionCookie(value: string, maxAgeSeconds?: number): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    `SameSite=${COOKIE_SAME_SITE}`,
  ];

  if (COOKIE_SECURE) {
    parts.push('Secure');
  }

  if (typeof maxAgeSeconds === 'number') {
    parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
  }

  return parts.join('; ');
}

function clearSessionCookie(): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    `SameSite=${COOKIE_SAME_SITE}`,
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'Max-Age=0',
  ];

  if (COOKIE_SECURE) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

function isLoopbackIp(ip: string | undefined): boolean {
  if (!ip) return false;
  return ip === '127.0.0.1'
    || ip === '::1'
    || ip === '::ffff:127.0.0.1'
    || ip === 'localhost';
}

function getClientIp(req: http.IncomingMessage): string | undefined {
  const forwarded = req.headers['x-forwarded-for'];
  if (config.TRUST_PROXY && typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || undefined;
}

function readBody(req: http.IncomingMessage): Promise<{ rawBody: string; body: RequestBody }> {
  const contentType = String(req.headers['content-type'] || '');
  const expectsJson = !contentType || /application\/json|text\/plain/i.test(contentType);
  if (!expectsJson) {
    throw new HttpError(415, 'Unsupported content type', { code: 'UNSUPPORTED_CONTENT_TYPE' });
  }

  return new Promise((resolve, reject) => {
    let rawBody = '';
    let size = 0;

    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Request body too large', { code: 'REQUEST_TOO_LARGE' }));
        req.destroy();
        return;
      }
      rawBody += chunk;
    });

    req.on('end', () => {
      if (!rawBody) {
        resolve({ rawBody: '', body: {} });
        return;
      }

      try {
        resolve({ rawBody, body: JSON.parse(rawBody) as RequestBody });
      } catch {
        reject(new HttpError(400, 'Invalid JSON body', { code: 'INVALID_JSON' }));
      }
    });

    req.on('error', reject);
  });
}

function getSessionCookieMaxAge(expiresAt: string): number {
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return 0;
  }

  return Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000));
}

function getSlot(slotId: unknown): Slot | undefined {
  return SLOTS.find(slot => slot.id === slotId);
}

function getEffectiveSettings(): Record<string, unknown> {
  return {
    REDDIT_USER: config.REDDIT_USER,
    REDDIT_ALLOWED_SUBS: [...config.REDDIT_ALLOWED_SUBS],
    REDDIT_SORT: config.REDDIT_SORT,
    REDDIT_LIMIT: config.REDDIT_LIMIT,
    OPENAI_MODEL: config.OPENAI_MODEL,
    AI_STYLE: config.AI_STYLE,
    CUSTOM_PROMPT: config.CUSTOM_PROMPT,
    ENABLE_LINKEDIN: config.ENABLE_LINKEDIN,
    ENABLE_X: config.ENABLE_X,
    META_GRAPH_VERSION: config.META_GRAPH_VERSION,
    THREADS_GRAPH_VERSION: config.THREADS_GRAPH_VERSION,
    ENABLE_THREADS: config.ENABLE_THREADS,
    ENABLE_INSTAGRAM: config.ENABLE_INSTAGRAM,
    ENABLE_FACEBOOK: config.ENABLE_FACEBOOK,
    THREADS_USER_ID: config.THREADS_USER_ID,
    FACEBOOK_USER_ID: config.FACEBOOK_USER_ID,
    FACEBOOK_PAGE_ID: config.FACEBOOK_PAGE_ID,
    INSTAGRAM_ACCOUNT_ID: config.INSTAGRAM_ACCOUNT_ID,
    FACEBOOK_GROUP_ID: config.FACEBOOK_GROUP_ID,
    CLOUDINARY_FOLDER: config.CLOUDINARY_FOLDER,
    TIMEZONE: config.TIMEZONE,
    TRUST_PROXY: config.TRUST_PROXY,
    BOOTSTRAP_MODE: config.BOOTSTRAP_MODE,
  };
}

function getStripeConfigSummary(): Record<string, unknown> {
  return {
    configured: Boolean(STRIPE_SECRET_KEY),
    webhookConfigured: Boolean(STRIPE_WEBHOOK_SECRET),
    priceIds: {
      monthly: Boolean(STRIPE_PRICE_MONTHLY_GBP),
      yearly: Boolean(STRIPE_PRICE_YEARLY_GBP),
    },
    frontendBaseUrl: FRONTEND_BASE_URL,
  };
}

function getDevRuntimeIdentity(): Record<string, unknown> {
  const users = listUsers();
  const owner = users.find(user => user.role === 'owner');
  const billing = getBillingStateSnapshot();
  const gate = getAutomationGate();
  const runtimeUrl = process.env.API_BASE_URL
    || process.env.APP_BASE_URL
    || `http://localhost:${PORT}`;

  return {
    app: 'social-agent',
    environment: process.env.NODE_ENV || config.NODE_ENV || 'development',
    apiBaseUrl: runtimeUrl,
    runtimeUrl,
    databasePath: getControlPlaneDatabasePath(),
    ownerExists: Boolean(owner),
    ownerEmail: owner?.email || null,
    billingStatus: billing.status,
    trialEndsAt: billing.trialEndsAt || null,
    storedAccessActive: billing.accessActive,
    accessActive: gate.billingAccessActive,
    automationAllowed: gate.allowed,
    billingBypassForLocalDev: isLocalDevBillingBypassActive(),
    serverTime: new Date().toISOString(),
  };
}

async function stripeFormPost(
  pathname: string,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  if (!STRIPE_SECRET_KEY) {
    throw new HttpError(503, 'Billing is not configured', { code: 'STRIPE_NOT_CONFIGURED' });
  }

  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    body.append(key, value);
  }

  const response = await fetch(`https://api.stripe.com${pathname}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    signal: AbortSignal.timeout(config.HTTP_TIMEOUT_MS),
  });

  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    throw new HttpError(502, 'Stripe request failed', {
      code: 'STRIPE_REQUEST_FAILED',
      details: {
        status: response.status,
      },
      expose: false,
    });
  }

  return payload;
}

function getSubscriptionPriceId(interval: 'monthly' | 'yearly'): string {
  if (interval === 'yearly') {
    if (!STRIPE_PRICE_YEARLY_GBP) {
      throw new HttpError(503, 'Billing is not configured', { code: 'STRIPE_PRICE_NOT_CONFIGURED' });
    }
    return STRIPE_PRICE_YEARLY_GBP;
  }

  if (!STRIPE_PRICE_MONTHLY_GBP) {
    throw new HttpError(503, 'Billing is not configured', { code: 'STRIPE_PRICE_NOT_CONFIGURED' });
  }
  return STRIPE_PRICE_MONTHLY_GBP;
}

async function ensureStripeCustomer(user: AuthUser): Promise<string> {
  const billing = getBillingState();
  if (billing.stripeCustomerId) {
    return billing.stripeCustomerId;
  }

  const customer = await stripeFormPost('/v1/customers', {
    email: user.email,
    description: 'Social Agent single-tenant customer',
  });

  const customerId = String(customer.id || '');
  if (!customerId) {
    throw new HttpError(502, 'Stripe request failed', { code: 'STRIPE_CUSTOMER_MISSING', expose: false });
  }

  updateBillingCheckoutState({ stripeCustomerId: customerId });
  return customerId;
}

function verifyStripeSignature(rawBody: string, signatureHeader: string | undefined): boolean {
  if (!STRIPE_WEBHOOK_SECRET || !signatureHeader) {
    return false;
  }

  const parts = signatureHeader.split(',').map(part => part.trim());
  const timestampPart = parts.find(part => part.startsWith('t='));
  const signatures = parts
    .filter(part => part.startsWith('v1='))
    .map(part => part.slice(3));

  if (!timestampPart || !signatures.length) {
    return false;
  }

  const timestamp = Number.parseInt(timestampPart.slice(2), 10);
  if (!Number.isFinite(timestamp)) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > 300) {
    return false;
  }

  const signedPayload = `${timestamp}.${rawBody}`;
  const expected = crypto
    .createHmac('sha256', STRIPE_WEBHOOK_SECRET)
    .update(signedPayload, 'utf8')
    .digest('hex');

  return signatures.some(signature => (
    signature.length === expected.length
      && crypto.timingSafeEqual(Buffer.from(signature, 'utf8'), Buffer.from(expected, 'utf8'))
  ));
}

function parseStripeEvent(rawBody: string): Record<string, unknown> {
  try {
    return JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function assertBootstrapAllowed(req: http.IncomingMessage, ip: string | undefined): void {
  const setup = getSetupStatus();
  if (setup.hasOwner) {
    conflict('Owner account already exists', 'OWNER_EXISTS');
  }

  if (config.BOOTSTRAP_MODE === 'disabled') {
    notFound();
  }

  if (config.BOOTSTRAP_MODE === 'localhost' && !isLoopbackIp(ip)) {
    forbidden('Bootstrap is restricted', 'BOOTSTRAP_FORBIDDEN');
  }

  if (config.BOOTSTRAP_MODE === 'token') {
    const header = req.headers['x-bootstrap-token'];
    const token = Array.isArray(header) ? header[0] : header;
    if (!token || token !== config.BOOTSTRAP_TOKEN) {
      forbidden('Bootstrap token required', 'BOOTSTRAP_TOKEN_REQUIRED');
    }
  }
}

function mapInternalError(error: unknown): HttpError {
  if (isHttpError(error)) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  if (message === 'Invalid JSON body') {
    return new HttpError(400, message, { code: 'INVALID_JSON' });
  }
  if (message === 'Request body too large') {
    return new HttpError(413, message, { code: 'REQUEST_TOO_LARGE' });
  }

  return new HttpError(500, 'Internal server error', {
    code: 'INTERNAL_SERVER_ERROR',
    expose: false,
  });
}

function logRequest(
  context: RequestContext,
  method: string,
  pathname: string,
  status: number,
  startedAt: number,
  extras?: Record<string, unknown>
): void {
  logger.info('request', {
    type: 'request',
    requestId: context.requestId,
    method,
    pathname,
    status,
    durationMs: Date.now() - startedAt,
    userId: context.user?.id,
    role: context.user?.role,
    ip: context.ip,
    ...extras,
  });
}

const routes: RouteDef[] = [
  {
    method: 'GET',
    path: '/healthz',
    handler: (_req, res, context) => {
      json(res, {
        ok: true,
        time: new Date().toISOString(),
      }, context.requestId, 200, context.origin);
    },
  },
  {
    method: 'GET',
    path: '/api/health/readiness',
    auth: true,
    roles: ['owner'],
    handler: (_req, res, context) => {
      json(res, {
        ok: true,
        time: new Date().toISOString(),
        db: getDbHealth(),
        setup: getSetupStatus(),
        readiness: getRuntimeReadiness(),
        automation: getAutomationGate(),
        stripe: getStripeConfigSummary(),
        productionConfigIssues: validateProductionConfig(),
      }, context.requestId, 200, context.origin);
    },
  },
  {
    method: 'GET',
    path: '/api/bootstrap/status',
    handler: (_req, res, context) => {
      const setup = getSetupStatus();
      if (setup.hasOwner) {
        json(res, { initialized: true }, context.requestId, 200, context.origin);
        return;
      }

      json(res, { initialized: false }, context.requestId, 200, context.origin);
    },
  },
  {
    method: 'GET',
    path: '/api/dev/runtime-identity',
    handler: (_req, res, context) => {
      if (isProductionRuntime()) {
        notFound('Not found', 'NOT_FOUND');
      }

      json(res, getDevRuntimeIdentity(), context.requestId, 200, context.origin);
    },
  },
  {
    method: 'GET',
    path: '/api/auth/me',
    allowPendingMfa: true,
    handler: (_req, res, context) => {
      if (!context.session) {
        json(res, {
          authenticated: false,
          initialized: getSetupStatus().hasOwner,
        }, context.requestId, 200, context.origin);
        return;
      }

      json(res, {
        authenticated: context.session.mfaVerified,
        mfaPending: !context.session.mfaVerified,
        user: context.session.user,
        csrfToken: context.session.csrfToken,
        mfa: getMfaStatus(context.session.user.id),
        billing: getBillingState(),
        readiness: getRuntimeReadiness(),
      }, context.requestId, 200, context.origin);
    },
  },
  {
    method: 'POST',
    path: '/api/auth/bootstrap',
    handler: (req, res, context) => {
      assertBootstrapAllowed(req, context.ip);
      const credentials = parseAuthCredentials(context.body);
      const session = bootstrapOwner(credentials.email, credentials.password, String(req.headers['user-agent'] || ''), context.ip);

      res.setHeader('Set-Cookie', buildSessionCookie(session.token, getSessionCookieMaxAge(session.expiresAt)));
      json(res, {
        authenticated: true,
        user: session.user,
        csrfToken: session.csrfToken,
        mfa: getMfaStatus(session.user.id),
        billing: getBillingState(),
        readiness: getRuntimeReadiness(),
      }, context.requestId, 201, context.origin);
    },
  },
  {
    method: 'POST',
    path: '/api/auth/login',
    handler: (req, res, context) => {
      const credentials = parseAuthCredentials(context.body);
      const session = login(credentials.email, credentials.password, String(req.headers['user-agent'] || ''), context.ip);

      res.setHeader('Set-Cookie', buildSessionCookie(session.token, getSessionCookieMaxAge(session.expiresAt)));
      json(res, {
        authenticated: session.mfaVerified,
        mfaPending: !session.mfaVerified,
        user: session.user,
        csrfToken: session.csrfToken,
        mfa: getMfaStatus(session.user.id),
        billing: session.mfaVerified ? getBillingState() : undefined,
        readiness: session.mfaVerified ? getRuntimeReadiness() : undefined,
      }, context.requestId, 200, context.origin);
    },
  },
  {
    method: 'POST',
    path: '/api/auth/mfa/setup',
    auth: true,
    csrf: true,
    allowPendingMfa: true,
    handler: (_req, res, context) => {
      const enrollment = beginMfaEnrollment(context.user!.id);
      recordAudit('auth.mfa.setup', 'user', {}, context.ip, context.user?.id);
      json(res, enrollment, context.requestId, 200, context.origin);
    },
  },
  {
    method: 'POST',
    path: '/api/auth/mfa/enable',
    auth: true,
    csrf: true,
    allowPendingMfa: true,
    handler: (req, res, context) => {
      const { otp } = parseTotp(context.body);
      enableMfa(context.user!.id, otp);
      const nextSession = issueSessionForUser(context.user!.id, String(req.headers['user-agent'] || ''), context.ip, {
        revokeExisting: true,
        mfaVerified: true,
      });
      res.setHeader('Set-Cookie', buildSessionCookie(nextSession.token, getSessionCookieMaxAge(nextSession.expiresAt)));
      recordAudit('auth.mfa.enabled', 'user', {}, context.ip, context.user?.id);
      json(res, {
        authenticated: true,
        user: nextSession.user,
        csrfToken: nextSession.csrfToken,
        mfa: getMfaStatus(nextSession.user.id),
      }, context.requestId, 200, context.origin);
    },
  },
  {
    method: 'POST',
    path: '/api/auth/mfa/verify',
    auth: true,
    csrf: true,
    allowPendingMfa: true,
    handler: (req, res, context) => {
      const { otp } = parseTotp(context.body);
      const nextSession = verifyMfaSession(context.cookies[SESSION_COOKIE_NAME], otp, String(req.headers['user-agent'] || ''), context.ip);
      res.setHeader('Set-Cookie', buildSessionCookie(nextSession.token, getSessionCookieMaxAge(nextSession.expiresAt)));
      recordAudit('auth.mfa.verified', 'user', {}, context.ip, context.user?.id);
      json(res, {
        authenticated: true,
        user: nextSession.user,
        csrfToken: nextSession.csrfToken,
        mfa: getMfaStatus(nextSession.user.id),
        billing: getBillingState(),
        readiness: getRuntimeReadiness(),
      }, context.requestId, 200, context.origin);
    },
  },
  {
    method: 'POST',
    path: '/api/auth/mfa/disable',
    auth: true,
    csrf: true,
    allowPendingMfa: true,
    handler: (_req, res, context) => {
      const body = asObject(context.body, 'body');
      const currentPassword = String(body.currentPassword || '');
      const otp = typeof body.otp === 'string' ? body.otp.trim() : undefined;
      disableMfa(context.user!.id, currentPassword, otp);
      res.setHeader('Set-Cookie', clearSessionCookie());
      recordAudit('auth.mfa.disabled', 'user', {}, context.ip, context.user?.id);
      json(res, { success: true, reauthenticate: true }, context.requestId, 200, context.origin);
    },
  },
  {
    method: 'GET',
    path: '/api/auth/mfa/status',
    auth: true,
    allowPendingMfa: true,
    handler: (_req, res, context) => {
      json(res, getMfaStatus(context.user!.id), context.requestId, 200, context.origin);
    },
  },
  {
    method: 'POST',
    path: '/api/auth/logout',
    auth: true,
    csrf: true,
    allowPendingMfa: true,
    handler: (_req, res, context) => {
      destroySession(context.cookies[SESSION_COOKIE_NAME]);
      res.setHeader('Set-Cookie', clearSessionCookie());
      recordAudit('auth.logout', 'session', {}, context.ip, context.user?.id);
      json(res, { success: true }, context.requestId, 200, context.origin);
    },
  },
  {
    method: 'POST',
    path: '/api/auth/logout-all',
    auth: true,
    csrf: true,
    allowPendingMfa: true,
    handler: (_req, res, context) => {
      logoutAllSessions(context.user!.id);
      res.setHeader('Set-Cookie', clearSessionCookie());
      recordAudit('auth.logout_all', 'session', {}, context.ip, context.user?.id);
      json(res, { success: true }, context.requestId, 200, context.origin);
    },
  },
  {
    method: 'POST',
    path: '/api/auth/password',
    auth: true,
    csrf: true,
    handler: (_req, res, context) => {
      const body = asObject(context.body, 'body');
      const payload = parsePasswordChange(body);
      changePassword(context.user!.id, payload.currentPassword, payload.nextPassword);
      res.setHeader('Set-Cookie', clearSessionCookie());
      recordAudit('auth.password.change', 'user', {}, context.ip, context.user?.id);
      json(res, { success: true, reauthenticate: true }, context.requestId, 200, context.origin);
    },
  },
  {
    method: 'GET',
    path: '/api/users',
    auth: true,
    roles: ['owner'],
    handler: (_req, res, context) => {
      json(res, listUsers(), context.requestId, 200, context.origin);
    },
  },
  {
    method: 'POST',
    path: '/api/users',
    auth: true,
    roles: ['owner'],
    csrf: true,
    handler: (_req, res, context) => {
      const body = asObject(context.body, 'body');
      const payload = parseUserCreate(body);
      const user = createUser(payload.email, payload.password, payload.role);
      recordAudit('users.create', 'user', { userId: user.id, role: user.role }, context.ip, context.user?.id);
      json(res, user, context.requestId, 201, context.origin);
    },
  },
  {
    method: 'PUT',
    path: '/api/users',
    auth: true,
    roles: ['owner'],
    csrf: true,
    handler: (_req, res, context) => {
      const body = asObject(context.body, 'body');
      const payload = parseUserUpdate(body);
      if (payload.userId === context.user!.id && (payload.disabled || payload.role === 'operator' || payload.role === 'viewer')) {
        forbidden('Owner cannot disable or demote the active owner account', 'OWNER_SELF_CHANGE_FORBIDDEN');
      }
      const user = updateUser(payload.userId, {
        role: payload.role,
        disabled: payload.disabled,
      });
      recordAudit('users.update', 'user', { userId: user.id, role: user.role, disabled: user.disabled }, context.ip, context.user?.id);
      json(res, user, context.requestId, 200, context.origin);
    },
  },
  {
    method: 'POST',
    path: '/api/users/password',
    auth: true,
    roles: ['owner'],
    csrf: true,
    handler: (_req, res, context) => {
      const body = asObject(context.body, 'body');
      const payload = parseUserPasswordReset(body);
      resetUserPassword(payload.userId, payload.nextPassword);
      recordAudit('users.password.reset', 'user', { userId: payload.userId }, context.ip, context.user?.id);
      json(res, { success: true }, context.requestId, 200, context.origin);
    },
  },
  {
    method: 'GET',
    path: '/api/settings',
    auth: true,
    roles: ['owner'],
    handler: (_req, res, context) => {
      json(res, {
        runtime: getEffectiveSettings(),
        storedRuntimeSettings: getRuntimeSettings(),
        secretPresence: getRuntimeSecretPresence(),
        readiness: getRuntimeReadiness(),
        billing: getBillingState(),
      }, context.requestId, 200, context.origin);
    },
  },
  {
    method: 'GET',
    path: '/auth/x/start',
    auth: true,
    roles: ['owner'],
    handler: (_req, res, context) => {
      const state = crypto.randomUUID();
      const { codeVerifier, codeChallenge } = x.createOAuth2PkcePair();
      pendingXOAuth.set(state, { codeVerifier, createdAt: Date.now() });

      const url = x.buildOAuth2AuthorizationUrl(state, codeChallenge);
      recordAudit('x.oauth.start', 'x', {}, context.ip, context.user?.id);

      applySecurityHeaders(res, context.requestId);
      res.writeHead(302, { Location: url });
      res.end();
    },
  },
  {
    method: 'GET',
    path: '/auth/x/callback',
    handler: async (req, res, context) => {
      const parsed = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const error = parsed.searchParams.get('error');
      if (error) {
        badRequest(`X OAuth failed: ${error}`, 'X_OAUTH_ERROR');
      }

      const code = parsed.searchParams.get('code') || '';
      const state = parsed.searchParams.get('state') || '';
      const pending = pendingXOAuth.get(state);
      pendingXOAuth.delete(state);

      if (!code || !state || !pending) {
        badRequest('Invalid or expired X OAuth callback state', 'X_OAUTH_STATE_INVALID');
      }

      if (Date.now() - pending.createdAt > 10 * 60 * 1000) {
        badRequest('Expired X OAuth callback state', 'X_OAUTH_STATE_EXPIRED');
      }

      const tokens = await x.exchangeOAuth2Code(code, pending.codeVerifier);
      await x.persistOAuth2Tokens(tokens);
      reloadRuntimeConfigFromStorage();
      store.clearPlatformPublishBlocked('x');
      recordAudit('x.oauth.callback', 'x', { scope: tokens.scope || '' }, context.ip, context.user?.id);

      html(
        res,
        '<!doctype html><html><head><title>X connected</title></head><body><h1>X connected</h1><p>You can close this tab and rerun the X live-post test.</p></body></html>',
        context.requestId
      );
    },
  },
  {
    method: 'PUT',
    path: '/api/settings/runtime',
    auth: true,
    roles: ['owner'],
    csrf: true,
    handler: (_req, res, context) => {
      const body = asObject(context.body, 'body');
      const settings = parseRuntimeSettingsPatch(parseSettingsPayload(body));

      updateRuntimeSettings(settings);
      reloadRuntimeConfigFromStorage();
      recordAudit('settings.runtime.update', 'runtime_settings', { keys: Object.keys(settings) }, context.ip, context.user?.id);

      json(res, {
        success: true,
        runtime: getEffectiveSettings(),
        secretPresence: getRuntimeSecretPresence(),
        readiness: getRuntimeReadiness(),
      }, context.requestId, 200, context.origin);
    },
  },
  {
    method: 'PUT',
    path: '/api/settings/secrets',
    auth: true,
    roles: ['owner'],
    csrf: true,
    handler: (_req, res, context) => {
      const body = asObject(context.body, 'body');
      const secrets = parseSecretsPayload(body);

      updateRuntimeSecrets(secrets);
      reloadRuntimeConfigFromStorage();
      recordAudit('settings.secrets.update', 'runtime_secrets', { keys: Object.keys(secrets) }, context.ip, context.user?.id);

      json(res, {
        success: true,
        secretPresence: getRuntimeSecretPresence(),
        readiness: getRuntimeReadiness(),
      }, context.requestId, 200, context.origin);
    },
  },
  {
    method: 'GET',
    path: '/api/billing',
    auth: true,
    roles: ['owner'],
    handler: (_req, res, context) => {
      json(res, {
        billing: getBillingState(),
        stripe: getStripeConfigSummary(),
      }, context.requestId, 200, context.origin);
    },
  },
  {
    method: 'POST',
    path: '/api/billing/checkout-session',
    auth: true,
    roles: ['owner'],
    csrf: true,
    handler: async (_req, res, context) => {
      const body = asObject(context.body, 'body');
      const interval = parseCheckoutInterval(body);
      const priceId = getSubscriptionPriceId(interval);
      const customerId = await ensureStripeCustomer(context.user!);

      const session = await stripeFormPost('/v1/checkout/sessions', {
        mode: 'subscription',
        customer: customerId,
        success_url: `${FRONTEND_BASE_URL.replace(/\/$/, '')}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${FRONTEND_BASE_URL.replace(/\/$/, '')}/billing/cancel`,
        'line_items[0][price]': priceId,
        'line_items[0][quantity]': '1',
        'subscription_data[trial_period_days]': String(process.env.TRIAL_DAYS || '7'),
      });

      updateBillingCheckoutState({
        stripeCustomerId: customerId,
        stripeCheckoutSessionId: String(session.id || ''),
        planInterval: interval,
      });

      recordAudit('billing.checkout_session.create', 'stripe', { interval }, context.ip, context.user?.id);

      json(res, {
        id: session.id,
        url: session.url,
      }, context.requestId, 200, context.origin);
    },
  },
  {
    method: 'POST',
    path: '/api/billing/portal-session',
    auth: true,
    roles: ['owner'],
    csrf: true,
    handler: async (_req, res, context) => {
      const billing = getBillingState();
      if (!billing.stripeCustomerId) {
        conflict('No Stripe customer is linked to this installation yet', 'STRIPE_CUSTOMER_MISSING');
      }

      const session = await stripeFormPost('/v1/billing_portal/sessions', {
        customer: billing.stripeCustomerId!,
        return_url: `${FRONTEND_BASE_URL.replace(/\/$/, '')}/billing`,
      });

      recordAudit('billing.portal_session.create', 'stripe', {}, context.ip, context.user?.id);
      json(res, { url: session.url }, context.requestId, 200, context.origin);
    },
  },
  {
    method: 'POST',
    path: '/api/billing/webhook',
    handler: (_req, res, context) => {
      if (!verifyStripeSignature(context.rawBody, typeof _req.headers['stripe-signature'] === 'string' ? _req.headers['stripe-signature'] : undefined)) {
        jsonErr(res, context.requestId, 'Invalid Stripe webhook signature', 400, context.origin);
        return;
      }

      const event = parseStripeEvent(context.rawBody);
      const eventType = String(event.type || '');
      const dataObject = (event.data && typeof event.data === 'object' && 'object' in event.data)
        ? (event.data as { object?: Record<string, unknown> }).object || {}
        : {};

      if (eventType === 'checkout.session.completed') {
        updateBillingCheckoutState({
          stripeCustomerId: typeof dataObject.customer === 'string' ? dataObject.customer : undefined,
          stripeSubscriptionId: typeof dataObject.subscription === 'string' ? dataObject.subscription : undefined,
          stripeCheckoutSessionId: typeof dataObject.id === 'string' ? dataObject.id : undefined,
        });
      }

      if (
        eventType === 'customer.subscription.created'
        || eventType === 'customer.subscription.updated'
        || eventType === 'customer.subscription.deleted'
        || eventType === 'customer.subscription.paused'
        || eventType === 'customer.subscription.resumed'
      ) {
        updateBillingFromStripeSubscription(dataObject);
      }

      recordAudit('billing.webhook.processed', 'stripe_webhook', { eventType }, context.ip);
      json(res, { received: true }, context.requestId, 200, context.origin);
    },
  },
  {
    method: 'GET',
    path: '/api/audit-logs',
    auth: true,
    roles: ['owner'],
    handler: (_req, res, context) => {
      json(res, getAuditLogs(100), context.requestId, 200, context.origin);
    },
  },
  {
    method: 'GET',
    path: '/api/status',
    auth: true,
    roles: ['owner', 'operator', 'viewer'],
    handler: (_req, res, context) => {
      const queue = store.getQueue();
      const memory = store.getMemoryStats();
      const readiness = getRuntimeReadiness();
      const billing = getBillingState();

      json(res, {
        slots: SLOTS.map(slot => ({ ...slot, post: queue[slot.id] || null })),
        stats: {
          queued: SLOTS.filter(slot => queue[slot.id]).length,
          posted: store.getHistory().length,
          usedPosts: store.getUsedIds().size,
          bankedSources: memory.sources.banked,
          exhaustedSources: memory.sources.exhausted,
          readyAngles: memory.angles.ready,
          queuedAngles: memory.angles.queued,
          publishedAngles: memory.angles.published,
        },
        memory,
        readiness,
        billing,
        config: {
          redditUser: config.REDDIT_USER,
          allowedSubs: [...config.REDDIT_ALLOWED_SUBS],
          model: config.OPENAI_MODEL,
          timezone: config.TIMEZONE,
          platforms: {
            linkedin: config.ENABLE_LINKEDIN,
            threads: config.ENABLE_THREADS,
            x: config.ENABLE_X,
            instagram: config.ENABLE_INSTAGRAM,
            facebook: config.ENABLE_FACEBOOK,
          },
        },
      }, context.requestId, 200, context.origin);
    },
  },
  {
    method: 'GET',
    path: '/api/queue',
    auth: true,
    roles: ['owner', 'operator', 'viewer'],
    handler: (_req, res, context) => {
      const queue = store.getQueue();
      json(res, SLOTS.map(slot => ({ slot, post: queue[slot.id] || null })), context.requestId, 200, context.origin);
    },
  },
  {
    method: 'GET',
    path: '/api/history',
    auth: true,
    roles: ['owner', 'operator', 'viewer'],
    handler: (_req, res, context) => {
      json(res, store.getHistory().slice(0, 50), context.requestId, 200, context.origin);
    },
  },
  {
    method: 'GET',
    path: '/api/memory',
    auth: true,
    roles: ['owner', 'operator', 'viewer'],
    handler: (_req, res, context) => {
      json(res, {
        stats: store.getMemoryStats(),
        sources: store.getSources().slice(0, 50),
        recentAngles: store.getAngles().slice(-100).reverse().slice(0, 50),
      }, context.requestId, 200, context.origin);
    },
  },
  {
    method: 'GET',
    path: '/api/logs',
    auth: true,
    roles: ['owner', 'operator'],
    handler: (_req, res, context) => {
      const logDir = process.env.APP_DATA_DIR
        ? path.resolve(process.env.APP_DATA_DIR)
        : path.join(getProjectRoot(), 'data');
      const logFile = path.join(logDir, 'agent.log');
      try {
        const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
        json(res, lines.slice(-150).reverse(), context.requestId, 200, context.origin);
      } catch {
        json(res, [], context.requestId, 200, context.origin);
      }
    },
  },
  {
    method: 'POST',
    path: '/api/fetch',
    auth: true,
    roles: ['owner', 'operator'],
    csrf: true,
    billing: 'automation',
    handler: async (_req, res, context) => {
      const result = await runFetch(SLOTS, {
        source: 'api',
        userId: context.user?.id,
        requestId: context.requestId,
      }, logger);
      logger.info(`[API] Fetch done - filled:${result.stats.filled} reused:${result.stats.reusedAngles} extracted:${result.stats.extractedSources}`);
      recordAudit('automation.fetch', 'queue', result.stats as unknown as Record<string, unknown>, context.ip, context.user?.id);
      json(res, { ...result.stats, memory: result.memory }, context.requestId, 200, context.origin);
    },
  },
  {
    method: 'POST',
    path: '/api/post-slot',
    auth: true,
    roles: ['owner', 'operator'],
    csrf: true,
    billing: 'automation',
    handler: async (_req, res, context) => {
      const slot = getSlot(parseSlotId(context.body));
      if (!slot) {
        badRequest('Invalid slot', 'INVALID_SLOT');
      }
      const result = await runPostSlot(slot, {
        source: 'api',
        userId: context.user?.id,
        requestId: context.requestId,
      }, logger);
      recordAudit('automation.post_slot', slot.id, {
        completed: result.success,
        pendingPlatforms: result.pendingPlatforms,
      }, context.ip, context.user?.id);

      json(res, {
        success: result.success,
        queuedForRetry: result.queuedForRetry,
        ids: result.ids,
        errors: result.errors,
        pendingPlatforms: result.pendingPlatforms,
        memory: result.memory,
      }, context.requestId, 200, context.origin);
    },
  },
  {
    method: 'POST',
    path: '/api/post-all',
    auth: true,
    roles: ['owner', 'operator'],
    csrf: true,
    billing: 'automation',
    handler: async (_req, res, context) => {
      const result = await runPostAll(SLOTS, {
        source: 'api',
        userId: context.user?.id,
        requestId: context.requestId,
      }, logger);
      recordAudit('automation.post_all', 'queue', { processed: result.results.length }, context.ip, context.user?.id);
      json(res, result, context.requestId, 200, context.origin);
    },
  },
  {
    method: 'PUT',
    path: '/api/slot',
    auth: true,
    roles: ['owner', 'operator'],
    csrf: true,
    billing: 'automation',
    handler: async (_req, res, context) => {
      const slotId = parseSlotId(context.body);
      const slot = getSlot(slotId);
      if (!slot) {
        badRequest('slotId required', 'MISSING_SLOT_ID');
      }

      const updates = parseSlotUpdates(asObject(context.body, 'body'));
      const result = await runUpdateSlot(slot, updates as Partial<QueueItem>, {
        source: 'api',
        userId: context.user?.id,
        requestId: context.requestId,
      });
      recordAudit('automation.slot.update', slot.id, { keys: Object.keys(updates) }, context.ip, context.user?.id);
      json(res, result, context.requestId, 200, context.origin);
    },
  },
  {
    method: 'DELETE',
    path: '/api/slot',
    auth: true,
    roles: ['owner', 'operator'],
    csrf: true,
    billing: 'automation',
    handler: async (_req, res, context) => {
      const slot = getSlot(parseSlotId(context.body));
      if (!slot) {
        badRequest('slotId required', 'MISSING_SLOT_ID');
      }

      const result = await runReleaseSlot(slot, {
        source: 'api',
        userId: context.user?.id,
        requestId: context.requestId,
      });
      recordAudit('automation.slot.release', slot.id, {}, context.ip, context.user?.id);
      json(res, { success: true, ...result }, context.requestId, 200, context.origin);
    },
  },
];

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const startedAt = Date.now();
  const requestId = crypto.randomUUID();
  const parsed = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = parsed.pathname || '/';
  const origin = getAllowedOrigin(getRequestOrigin(req), pathname);
  const method = req.method || 'GET';

  if (method === 'OPTIONS') {
    applyCorsHeaders(res, origin);
    applySecurityHeaders(res, requestId);
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-CSRF-Token, Stripe-Signature, X-Bootstrap-Token',
      'Access-Control-Max-Age': '600',
    });
    res.end();
    return;
  }

  const route = routes.find(entry => entry.method === method && entry.path === pathname);
  if (route) {
    const context: RequestContext = {
      requestId,
      body: {},
      rawBody: '',
      cookies: parseCookies(req),
      origin,
      ip: getClientIp(req),
    };

    try {
      const bodyResult = ['POST', 'PUT', 'DELETE'].includes(method)
        ? await readBody(req)
        : { rawBody: '', body: {} };
      context.rawBody = bodyResult.rawBody;
      context.body = optionalObject(bodyResult.body);

      const session = getSession(context.cookies[SESSION_COOKIE_NAME]);
      if (session) {
        context.session = session;
        context.user = session.user;
      }

      if (route.auth && !context.session) {
        unauthorized();
      }

      if (route.auth && context.session?.user.disabled) {
        destroySession(context.cookies[SESSION_COOKIE_NAME]);
        unauthorized('Authentication required', 'SESSION_DISABLED');
      }

      if (route.auth && route.roles && context.user && !route.roles.includes(context.user.role)) {
        forbidden('You do not have access to this route', 'ROLE_FORBIDDEN');
      }

      if (route.auth && !route.allowPendingMfa && context.session?.user.mfaEnabled && !context.session.mfaVerified) {
        forbidden('MFA verification required', 'MFA_REQUIRED');
      }

      if (route.csrf) {
        const csrfHeader = req.headers['x-csrf-token'];
        const csrfToken = Array.isArray(csrfHeader) ? csrfHeader[0] : csrfHeader;
        if (!assertCsrf(context.session, csrfToken)) {
          forbidden('Invalid CSRF token', 'INVALID_CSRF');
        }
      }

      if (route.billing === 'automation') {
        const gate = getAutomationGate();
        if (!gate.allowed) {
          forbidden('Automation is not available', 'AUTOMATION_BLOCKED', { gate });
        }
      }

      await route.handler(req, res, context);
      logRequest(context, method, pathname, res.statusCode || 200, startedAt);
      return;
    } catch (error) {
      const mapped = mapInternalError(error);
      const rawMessage = error instanceof Error ? error.message : String(error);
      logger.error('request_error', {
        type: 'request_error',
        requestId,
        method,
        pathname,
        status: mapped.status,
        errorMessage: rawMessage,
        ip: context.ip,
        userId: context.user?.id,
      });

      if (mapped.status === 401 || mapped.status === 403 || mapped.status === 429) {
        recordAudit('security.request.denied', pathname, {
          status: mapped.status,
          code: mapped.code,
          method,
        }, context.ip, context.user?.id);
      }

      jsonErr(
        res,
        requestId,
        mapped.expose ? mapped.message : 'Internal server error',
        mapped.status,
        origin,
        mapped.expose ? {
          ...(mapped.code ? { code: mapped.code } : {}),
          ...(mapped.details ? { details: mapped.details } : {}),
        } : undefined
      );
      logRequest(context, method, pathname, mapped.status, startedAt, mapped.code ? { errorCode: mapped.code } : undefined);
      return;
    }
  }

  const publicDir = path.join(getRuntimeRoot(), 'public');
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(publicDir, requestedPath.replace(/^\/+/, ''));

  if (!filePath.startsWith(publicDir)) {
    applySecurityHeaders(res, requestId);
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime = ({
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.ico': 'image/x-icon',
  } as Record<string, string>)[ext] || 'application/octet-stream';

  try {
    const data = fs.readFileSync(filePath);
    applyCorsHeaders(res, origin);
    applySecurityHeaders(res, requestId, mime);
    res.writeHead(200);
    res.end(data);
  } catch {
    applySecurityHeaders(res, requestId);
    res.writeHead(404);
    res.end('Not found');
  }
}

export function startServer(port = PORT): http.Server {
  if (activeServer) {
    return activeServer;
  }

  const productionIssues = validateProductionConfig();
  if (productionIssues.length) {
    throw new Error(`Invalid production configuration: ${productionIssues.join(' | ')}`);
  }

  activeServer = http.createServer((req, res) => {
    void handleRequest(req, res);
  });
  activeServer.listen(port, () => {
    logger.info(`Dashboard/API running at http://localhost:${port}`);
    const gate = getAutomationGate();
    if (gate.localBillingBypassActive) {
      logger.warn('LOCAL DEV BILLING BYPASS ACTIVE | automation access ignores stored billing state outside production', {
        nodeEnv: process.env.NODE_ENV || config.NODE_ENV || 'development',
        storedBillingStatus: gate.billing.status,
        storedAccessActive: gate.billing.accessActive,
      });
    }
  });
  return activeServer;
}

export async function stopServer(): Promise<void> {
  if (!activeServer) return;
  const server = activeServer;
  activeServer = undefined;
  await new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

if (require.main === module) {
  startServer();
}
