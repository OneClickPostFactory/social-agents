import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { QueueItem } from '../src/types';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'social-agent-sec-'));
const dataDir = path.join(tempRoot, 'data');
const port = 4511;

process.env.APP_DATA_DIR = dataDir;
process.env.GUI_PORT = String(port);
process.env.BOOTSTRAP_MODE = 'token';
process.env.BOOTSTRAP_TOKEN = 'bootstrap-secret';
process.env.NODE_ENV = 'development';
process.env.COOKIE_SECURE = 'false';
process.env.TRUST_PROXY = 'true';
process.env.AUTH_MAX_ATTEMPTS = '2';
process.env.AUTH_LOCK_MINUTES = '1';
process.env.AUTH_ATTEMPT_WINDOW_MINUTES = '5';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.REDDIT_USER = 'tester';
process.env.REDDIT_ALLOWED_SUBS = 'testing';
process.env.ENABLE_X = 'true';
process.env.X_OAUTH2_ACCESS_TOKEN = 'x-test-token';
process.env.ENABLE_THREADS = 'false';
process.env.ENABLE_INSTAGRAM = 'false';
process.env.ENABLE_LINKEDIN = 'false';
process.env.ENABLE_FACEBOOK = 'false';
process.env.BILLING_BYPASS_FOR_LOCAL_DEV = 'true';

const baseUrl = `http://127.0.0.1:${port}`;
const currentPassword = {
  value: 'AdminPass123!',
};

function createClient(forwardedFor?: string) {
  let cookie = '';

  return {
    async request(pathname: string, init: RequestInit = {}): Promise<{ response: Response; data: any }> {
      const headers = new Headers(init.headers || {});
      if (cookie) {
        headers.set('cookie', cookie);
      }
      if (forwardedFor) {
        headers.set('x-forwarded-for', forwardedFor);
      }

      const response = await fetch(`${baseUrl}${pathname}`, {
        ...init,
        headers,
      });

      const setCookieHeader = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.()
        || (response.headers.get('set-cookie') ? [response.headers.get('set-cookie') as string] : []);
      if (setCookieHeader.length) {
        cookie = setCookieHeader.map(value => value.split(';', 1)[0]).join('; ');
      }

      let data: any = null;
      const text = await response.text();
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }

      return { response, data };
    },
  };
}

function base32Decode(value: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of value.replace(/=+$/g, '').toUpperCase()) {
    const index = alphabet.indexOf(char);
    assert.notEqual(index, -1);
    bits += index.toString(2).padStart(5, '0');
  }

  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  return Buffer.from(bytes);
}

function computeTotp(secret: string, now = Date.now()): string {
  const counter = Math.floor(now / 30000);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', base32Decode(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = (
    ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff)
  ) % 1_000_000;
  return String(code).padStart(6, '0');
}

async function run(name: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`- ${name}... `);
  await fn();
  process.stdout.write('ok\n');
}

async function main(): Promise<void> {
  const { startServer, stopServer } = await import('../src/server');
  const storeModule = await import('../src/store');
  const { validateProductionConfig } = await import('../config');
  const {
    isLocalDevBillingBypassActive,
    updateBillingCheckoutState,
  } = await import('../src/control-plane');

  const ownerState = {
    client: createClient(),
    csrf: '',
  };

  startServer(port);

  try {
    await run('public health is minimal and bootstrap is token-gated', async () => {
      const health = await fetch(`${baseUrl}/healthz`);
      assert.equal(health.status, 200);
      const healthJson = await health.json() as Record<string, unknown>;
      assert.equal(healthJson.ok, true);
      assert.equal('db' in healthJson, false);
      assert.equal('setup' in healthJson, false);
      assert.equal('readiness' in healthJson, false);

      const denied = await ownerState.client.request('/api/auth/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'owner@example.com', password: currentPassword.value }),
      });
      assert.equal(denied.response.status, 403);

      const bootstrap = await ownerState.client.request('/api/auth/bootstrap', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bootstrap-Token': 'bootstrap-secret',
        },
        body: JSON.stringify({ email: 'owner@example.com', password: currentPassword.value }),
      });
      assert.equal(bootstrap.response.status, 201);
      assert.equal(bootstrap.data.authenticated, true);
      ownerState.csrf = bootstrap.data.csrfToken;
    });

    await run('dev runtime identity exposes safe local backend facts', async () => {
      updateBillingCheckoutState({
        status: 'canceled',
        lockedReason: 'Trial expired without an active subscription',
      });

      const identity = await fetch(`${baseUrl}/api/dev/runtime-identity`, {
        headers: {
          Origin: 'http://localhost:5173',
        },
      });
      assert.equal(identity.status, 200);
      assert.equal(identity.headers.get('access-control-allow-origin'), 'http://localhost:5173');
      const data = await identity.json() as Record<string, unknown>;
      assert.equal(data.app, 'social-agent');
      assert.equal(data.environment, 'development');
      assert.equal(data.ownerExists, true);
      assert.equal(data.ownerEmail, 'owner@example.com');
      assert.equal(data.billingStatus, 'canceled');
      assert.equal(data.storedAccessActive, false);
      assert.equal(data.accessActive, true);
      assert.equal(data.billingBypassForLocalDev, true);
      assert.equal('password_hash' in data, false);
      assert.equal('tokens' in data, false);
      assert.equal('secrets' in data, false);
    });

    await run('local billing bypass is disabled in production', async () => {
      const previousNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        assert.equal(isLocalDevBillingBypassActive(), false);
        const identity = await fetch(`${baseUrl}/api/dev/runtime-identity`);
        assert.equal(identity.status, 404);
      } finally {
        process.env.NODE_ENV = previousNodeEnv;
      }
    });

    await run('failed logins are throttled', async () => {
      const attacker = createClient('203.0.113.7');

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await attacker.request('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'unknown@example.com', password: 'wrong-password' }),
        });
        assert.equal(result.response.status, 401);
      }

      const lockedAttempt = await attacker.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'unknown@example.com', password: 'wrong-password' }),
      });
      assert.equal(lockedAttempt.response.status, 429);
      assert.equal(lockedAttempt.data.code, 'AUTH_THROTTLED');
    });

    await run('password changes revoke the existing session', async () => {
      const changed = await ownerState.client.request('/api/auth/password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': ownerState.csrf,
        },
        body: JSON.stringify({
          currentPassword: currentPassword.value,
          nextPassword: 'NewPass123!!',
        }),
      });
      assert.equal(changed.response.status, 200);
      currentPassword.value = 'NewPass123!!';

      const stale = await ownerState.client.request('/api/users');
      assert.equal(stale.response.status, 401);

      ownerState.client = createClient();
      const login = await ownerState.client.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'owner@example.com',
          password: currentPassword.value,
        }),
      });
      assert.equal(login.response.status, 200);
      ownerState.csrf = login.data.csrfToken;
    });

    await run('mfa enrollment and verification require a second step', async () => {
      const setup = await ownerState.client.request('/api/auth/mfa/setup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': ownerState.csrf,
        },
        body: JSON.stringify({}),
      });
      assert.equal(setup.response.status, 200);
      assert.ok(typeof setup.data.secret === 'string');

      const enable = await ownerState.client.request('/api/auth/mfa/enable', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': ownerState.csrf,
        },
        body: JSON.stringify({ otp: computeTotp(setup.data.secret) }),
      });
      assert.equal(enable.response.status, 200);
      ownerState.csrf = enable.data.csrfToken;

      const freshLogin = createClient();
      const login = await freshLogin.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'owner@example.com',
          password: currentPassword.value,
        }),
      });
      assert.equal(login.response.status, 200);
      assert.equal(login.data.authenticated, false);
      assert.equal(login.data.mfaPending, true);

      const bypassAttempt = await freshLogin.request('/api/users');
      assert.equal(bypassAttempt.response.status, 403);
      assert.equal(bypassAttempt.data.code, 'MFA_REQUIRED');

      const verify = await freshLogin.request('/api/auth/mfa/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': login.data.csrfToken,
        },
        body: JSON.stringify({ otp: computeTotp(setup.data.secret) }),
      });
      assert.equal(verify.response.status, 200);
      assert.equal(verify.data.authenticated, true);

      ownerState.client = freshLogin;
      ownerState.csrf = verify.data.csrfToken;
    });

    await run('rbac and safe slot mutation are enforced', async () => {
      const createViewer = await ownerState.client.request('/api/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': ownerState.csrf,
        },
        body: JSON.stringify({
          email: 'viewer@example.com',
          password: 'ViewerPass123!',
          role: 'viewer',
        }),
      });
      assert.equal(createViewer.response.status, 201);

      const viewer = createClient();
      const viewerLogin = await viewer.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'viewer@example.com',
          password: 'ViewerPass123!',
        }),
      });
      assert.equal(viewerLogin.response.status, 200);

      const viewerStatus = await viewer.request('/api/status');
      assert.equal(viewerStatus.response.status, 200);

      const viewerSettings = await viewer.request('/api/settings');
      assert.equal(viewerSettings.response.status, 403);

      const queuedItem: QueueItem = {
        redditId: 'reddit-1',
        title: 'Queued test',
        linkedin: 'LinkedIn copy',
        threads: 'Threads copy',
        x: 'X copy',
        instagram: 'Instagram copy',
        facebook: 'Facebook copy',
        imageUrl: 'https://example.com/test.png',
      };
      storeModule.setSlotPost('s1', queuedItem);

      const unsafeUpdate = await ownerState.client.request('/api/slot', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': ownerState.csrf,
        },
        body: JSON.stringify({
          slotId: 's1',
          updates: {
            ids: 'bad',
          },
        }),
      });
      assert.equal(unsafeUpdate.response.status, 400);
      assert.equal(unsafeUpdate.data.code, 'UNSAFE_SLOT_FIELD');
    });

    await run('automation locks prevent concurrent execution', async () => {
      await storeModule.withAutomationLock('test-lock', 'owner-a', async () => {
        let message = '';
        try {
          await storeModule.withAutomationLock('test-lock', 'owner-b', async () => undefined);
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        assert.match(message, /AUTOMATION_LOCKED|Automation lock is already held/);
      });
    });

    await run('production config validation rejects insecure production defaults', async () => {
      const issues = validateProductionConfig({
        NODE_ENV: 'production',
        APP_DATA_DIR: '',
        REDDIT_USER: 'user',
        REDDIT_ALLOWED_SUBS: new Set(['test']),
        REDDIT_SORT: 'new',
        REDDIT_LIMIT: 50,
        OPENAI_API_KEY: 'key',
        OPENAI_MODEL: 'gpt-4o',
        AI_STYLE: 'conversational',
        CUSTOM_PROMPT: '',
        ENABLE_LINKEDIN: false,
        ENABLE_X: true,
        META_ACCESS_TOKEN: '',
        META_GRAPH_VERSION: 'v25.0',
        THREADS_GRAPH_VERSION: 'v25.0',
        ENABLE_THREADS: false,
        ENABLE_INSTAGRAM: false,
        ENABLE_FACEBOOK: false,
        LINKEDIN_TOKEN: '',
        LINKEDIN_PERSON_URN: '',
        X_API_KEY: '',
        X_API_SECRET: '',
        X_ACCESS_TOKEN: '',
        X_ACCESS_TOKEN_SECRET: '',
        X_OAUTH2_ACCESS_TOKEN: '',
        X_OAUTH2_REFRESH_TOKEN: '',
        X_CLIENT_ID: '',
        X_CLIENT_SECRET: '',
        X_REDIRECT_URI: 'http://127.0.0.1:4001/auth/x/callback',
        THREADS_ACCESS_TOKEN: '',
        THREADS_USER_ID: '',
        FACEBOOK_PAGE_ACCESS_TOKEN: '',
        INSTAGRAM_ACCOUNT_ID: '',
        FACEBOOK_GROUP_ID: '',
        FACEBOOK_USER_ID: '',
        FACEBOOK_PAGE_ID: '',
        CLOUDINARY_CLOUD_NAME: '',
        CLOUDINARY_API_KEY: '',
        CLOUDINARY_API_SECRET: '',
        CLOUDINARY_UPLOAD_PRESET: '',
        CLOUDINARY_FOLDER: 'social-agent/instagram',
        TIMEZONE: 'UTC',
        GUI_PORT: 4001,
        TRUST_PROXY: false,
        BOOTSTRAP_MODE: 'localhost',
        BOOTSTRAP_TOKEN: '',
        HTTP_TIMEOUT_MS: 15000,
        BILLING_BYPASS_FOR_LOCAL_DEV: true,
        SUPABASE_URL: '',
        SUPABASE_SERVICE_ROLE_KEY: '',
        CREDENTIAL_ENCRYPTION_KEY: '',
        SUPABASE_WORKER_POLL_INTERVAL_MS: 10000,
        SUPABASE_WORKER_BATCH_SIZE: 10,
      });

      assert.ok(issues.some(issue => issue.includes('COOKIE_SECURE')));
      assert.ok(issues.some(issue => issue.includes('APP_ENCRYPTION_KEY')));
      assert.ok(issues.some(issue => issue.includes('BOOTSTRAP_MODE')));
      assert.ok(issues.some(issue => issue.includes('APP_DATA_DIR')));
      assert.ok(issues.some(issue => issue.includes('BILLING_BYPASS_FOR_LOCAL_DEV')));
    });

    await run('production config validation requires complete Supabase worker credentials', async () => {
      const issues = validateProductionConfig({
        NODE_ENV: 'production',
        APP_DATA_DIR: '/tmp/social-agent-test',
        REDDIT_USER: 'user',
        REDDIT_ALLOWED_SUBS: new Set(['test']),
        REDDIT_SORT: 'new',
        REDDIT_LIMIT: 50,
        OPENAI_API_KEY: 'key',
        OPENAI_MODEL: 'gpt-4o',
        AI_STYLE: 'conversational',
        CUSTOM_PROMPT: '',
        ENABLE_LINKEDIN: false,
        ENABLE_X: false,
        META_ACCESS_TOKEN: '',
        META_GRAPH_VERSION: 'v25.0',
        THREADS_GRAPH_VERSION: 'v25.0',
        ENABLE_THREADS: false,
        ENABLE_INSTAGRAM: false,
        ENABLE_FACEBOOK: false,
        LINKEDIN_TOKEN: '',
        LINKEDIN_PERSON_URN: '',
        X_API_KEY: '',
        X_API_SECRET: '',
        X_ACCESS_TOKEN: '',
        X_ACCESS_TOKEN_SECRET: '',
        X_OAUTH2_ACCESS_TOKEN: '',
        X_OAUTH2_REFRESH_TOKEN: '',
        X_CLIENT_ID: '',
        X_CLIENT_SECRET: '',
        X_REDIRECT_URI: 'http://127.0.0.1:4001/auth/x/callback',
        THREADS_ACCESS_TOKEN: '',
        THREADS_USER_ID: '',
        FACEBOOK_PAGE_ACCESS_TOKEN: '',
        INSTAGRAM_ACCOUNT_ID: '',
        FACEBOOK_GROUP_ID: '',
        FACEBOOK_USER_ID: '',
        FACEBOOK_PAGE_ID: '',
        CLOUDINARY_CLOUD_NAME: '',
        CLOUDINARY_API_KEY: '',
        CLOUDINARY_API_SECRET: '',
        CLOUDINARY_UPLOAD_PRESET: '',
        CLOUDINARY_FOLDER: 'social-agent/instagram',
        TIMEZONE: 'UTC',
        GUI_PORT: 4001,
        TRUST_PROXY: false,
        BOOTSTRAP_MODE: 'disabled',
        BOOTSTRAP_TOKEN: '',
        HTTP_TIMEOUT_MS: 15000,
        BILLING_BYPASS_FOR_LOCAL_DEV: false,
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: '',
        CREDENTIAL_ENCRYPTION_KEY: '',
        SUPABASE_WORKER_POLL_INTERVAL_MS: 10000,
        SUPABASE_WORKER_BATCH_SIZE: 10,
      });

      assert.ok(issues.some(issue => issue.includes('SUPABASE_SERVICE_ROLE_KEY')));
      assert.ok(issues.some(issue => issue.includes('CREDENTIAL_ENCRYPTION_KEY')));
    });
  } finally {
    await stopServer();
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // Ignore temp cleanup failures while SQLite handles are still draining.
    }
  }
}

void main().catch(error => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exit(1);
});
