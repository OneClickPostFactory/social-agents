import * as fs from 'node:fs';
import * as path from 'node:path';

function getProjectRoot(): string {
  if (process.env.CF_WORKER_RUNTIME === 'true') {
    return '/';
  }

  return path.basename(__dirname) === 'dist'
    ? path.resolve(__dirname, '..')
    : __dirname;
}

const PROJECT_ROOT = getProjectRoot();
const IS_CLOUDFLARE_WORKER = process.env.CF_WORKER_RUNTIME === 'true';

export interface AppConfig {
  NODE_ENV: string;
  APP_DATA_DIR: string;
  REDDIT_USER: string;
  REDDIT_ALLOWED_SUBS: Set<string>;
  REDDIT_SORT: string;
  REDDIT_LIMIT: number;
  OPENAI_API_KEY: string;
  OPENAI_MODEL: string;
  OPENAI_IMAGE_MODEL: string;
  OPENAI_IMAGE_TIMEOUT_MS: number;
  AI_STYLE: string;
  CUSTOM_PROMPT: string;
  ENABLE_LINKEDIN: boolean;
  ENABLE_X: boolean;
  META_ACCESS_TOKEN: string;
  META_GRAPH_VERSION: string;
  THREADS_GRAPH_VERSION: string;
  ENABLE_THREADS: boolean;
  ENABLE_INSTAGRAM: boolean;
  ENABLE_FACEBOOK: boolean;
  LINKEDIN_TOKEN: string;
  LINKEDIN_PERSON_URN: string;
  X_API_KEY: string;
  X_API_SECRET: string;
  X_ACCESS_TOKEN: string;
  X_ACCESS_TOKEN_SECRET: string;
  X_OAUTH2_ACCESS_TOKEN: string;
  X_OAUTH2_REFRESH_TOKEN: string;
  X_CLIENT_ID: string;
  X_CLIENT_SECRET: string;
  X_REDIRECT_URI: string;
  THREADS_ACCESS_TOKEN: string;
  THREADS_USER_ID: string;
  FACEBOOK_PAGE_ACCESS_TOKEN: string;
  INSTAGRAM_ACCOUNT_ID: string;
  FACEBOOK_GROUP_ID: string;
  FACEBOOK_USER_ID: string;
  FACEBOOK_PAGE_ID: string;
  CLOUDINARY_CLOUD_NAME: string;
  CLOUDINARY_API_KEY: string;
  CLOUDINARY_API_SECRET: string;
  CLOUDINARY_UPLOAD_PRESET: string;
  CLOUDINARY_FOLDER: string;
  TIMEZONE: string;
  GUI_PORT: number;
  TRUST_PROXY: boolean;
  BOOTSTRAP_MODE: 'disabled' | 'token' | 'localhost';
  BOOTSTRAP_TOKEN: string;
  HTTP_TIMEOUT_MS: number;
  BILLING_BYPASS_FOR_LOCAL_DEV: boolean;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  CREDENTIAL_ENCRYPTION_KEY: string;
  SUPABASE_WORKER_POLL_INTERVAL_MS: number;
  SUPABASE_WORKER_BATCH_SIZE: number;
}

const envPath = path.join(PROJECT_ROOT, '.env');

if (!IS_CLOUDFLARE_WORKER && fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;

    const key = trimmed.substring(0, eqIdx).trim();
    const val = trimmed.substring(eqIdx + 1).trim().replace(/^["']|["']$/g, '');

    if (key && !(key in process.env)) {
      process.env[key] = val;
    }
  }
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function parseBootstrapMode(value: string | undefined): 'disabled' | 'token' | 'localhost' {
  switch ((value || 'localhost').trim().toLowerCase()) {
    case 'disabled':
      return 'disabled';
    case 'token':
      return 'token';
    case 'localhost':
      return 'localhost';
    default:
      return 'localhost';
  }
}

function toSubSet(value: string | string[] | Set<string> | undefined, fallback: string): Set<string> {
  if (value instanceof Set) return new Set(value);
  const entries = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : fallback.split(',');

  return new Set(
    entries
      .map(sub => String(sub).trim().toLowerCase())
      .filter(Boolean)
  );
}

function buildBaseConfig(): AppConfig {
  return {
    NODE_ENV: process.env.NODE_ENV || 'development',
    APP_DATA_DIR: process.env.APP_DATA_DIR || path.join(PROJECT_ROOT, 'data'),
    REDDIT_USER: process.env.REDDIT_USER || 'advanced_pudding9228',
    REDDIT_ALLOWED_SUBS: toSubSet(process.env.REDDIT_ALLOWED_SUBS, 'openclawbot,lovablebuildershub'),
    REDDIT_SORT: process.env.REDDIT_SORT || 'new',
    REDDIT_LIMIT: Number.parseInt(process.env.REDDIT_LIMIT || '50', 10),
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
    OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o',
    OPENAI_IMAGE_MODEL: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2',
    OPENAI_IMAGE_TIMEOUT_MS: Number.parseInt(process.env.OPENAI_IMAGE_TIMEOUT_MS || '120000', 10),
    AI_STYLE: process.env.AI_STYLE || 'conversational',
    CUSTOM_PROMPT: process.env.CUSTOM_PROMPT || '',
    ENABLE_LINKEDIN: parseBooleanEnv(process.env.ENABLE_LINKEDIN, false),
    ENABLE_X: parseBooleanEnv(process.env.ENABLE_X, false),
    META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN || '',
    META_GRAPH_VERSION: process.env.META_GRAPH_VERSION || 'v25.0',
    THREADS_GRAPH_VERSION:
      process.env.THREADS_GRAPH_VERSION ||
      process.env.META_GRAPH_VERSION ||
      'v25.0',
    ENABLE_THREADS: parseBooleanEnv(process.env.ENABLE_THREADS, true),
    ENABLE_INSTAGRAM: parseBooleanEnv(process.env.ENABLE_INSTAGRAM, true),
    ENABLE_FACEBOOK: parseBooleanEnv(process.env.ENABLE_FACEBOOK, true),
    LINKEDIN_TOKEN: process.env.LINKEDIN_TOKEN || '',
    LINKEDIN_PERSON_URN: process.env.LINKEDIN_PERSON_URN || '',
    X_API_KEY: process.env.X_API_KEY || '',
    X_API_SECRET: process.env.X_API_SECRET || '',
    X_ACCESS_TOKEN: process.env.X_ACCESS_TOKEN || '',
    X_ACCESS_TOKEN_SECRET: process.env.X_ACCESS_TOKEN_SECRET || '',
    X_OAUTH2_ACCESS_TOKEN: process.env.X_OAUTH2_ACCESS_TOKEN || '',
    X_OAUTH2_REFRESH_TOKEN: process.env.X_OAUTH2_REFRESH_TOKEN || '',
    X_CLIENT_ID: process.env.X_CLIENT_ID || process.env.X_OAUTH2_CLIENT_ID || '',
    X_CLIENT_SECRET: process.env.X_CLIENT_SECRET || process.env.X_OAUTH2_CLIENT_SECRET || '',
    X_REDIRECT_URI: process.env.X_REDIRECT_URI || `http://127.0.0.1:${process.env.GUI_PORT || '4001'}/auth/x/callback`,
    THREADS_ACCESS_TOKEN:
      process.env.THREADS_ACCESS_TOKEN ||
      process.env.META_ACCESS_TOKEN ||
      '',
    THREADS_USER_ID: process.env.THREADS_USER_ID || '',
    FACEBOOK_PAGE_ACCESS_TOKEN: process.env.FACEBOOK_PAGE_ACCESS_TOKEN || '',
    INSTAGRAM_ACCOUNT_ID: process.env.INSTAGRAM_ACCOUNT_ID || '',
    FACEBOOK_GROUP_ID: process.env.FACEBOOK_GROUP_ID || '',
    FACEBOOK_USER_ID: process.env.FACEBOOK_USER_ID || '',
    FACEBOOK_PAGE_ID: process.env.FACEBOOK_PAGE_ID || '',
    CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME || '',
    CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY || '',
    CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET || '',
    CLOUDINARY_UPLOAD_PRESET: process.env.CLOUDINARY_UPLOAD_PRESET || '',
    CLOUDINARY_FOLDER: process.env.CLOUDINARY_FOLDER || 'social-agent/instagram',
    TIMEZONE: process.env.TIMEZONE || 'Europe/London',
    GUI_PORT: Number.parseInt(process.env.GUI_PORT || '4001', 10),
    TRUST_PROXY: parseBooleanEnv(process.env.TRUST_PROXY, false),
    BOOTSTRAP_MODE: parseBootstrapMode(process.env.BOOTSTRAP_MODE),
    BOOTSTRAP_TOKEN: process.env.BOOTSTRAP_TOKEN || '',
    HTTP_TIMEOUT_MS: Number.parseInt(process.env.HTTP_TIMEOUT_MS || '15000', 10),
    BILLING_BYPASS_FOR_LOCAL_DEV: parseBooleanEnv(process.env.BILLING_BYPASS_FOR_LOCAL_DEV, false),
    SUPABASE_URL: process.env.SUPABASE_URL || '',
    SUPABASE_SERVICE_ROLE_KEY:
      process.env.SUPABASE_SERVICE_ROLE_KEY
      || process.env.SUPABASE_SECRET_KEY
      || process.env.SERVICE_ROLE_KEY
      || '',
    CREDENTIAL_ENCRYPTION_KEY: process.env.CREDENTIAL_ENCRYPTION_KEY || '',
    SUPABASE_WORKER_POLL_INTERVAL_MS: Number.parseInt(process.env.SUPABASE_WORKER_POLL_INTERVAL_MS || '10000', 10),
    SUPABASE_WORKER_BATCH_SIZE: Number.parseInt(process.env.SUPABASE_WORKER_BATCH_SIZE || '10', 10),
  };
}

const config: AppConfig = buildBaseConfig();

export function applyRuntimeConfig(patch: Record<string, unknown>): AppConfig {
  if (typeof patch.REDDIT_USER === 'string') {
    config.REDDIT_USER = patch.REDDIT_USER;
  }
  if (
    typeof patch.REDDIT_ALLOWED_SUBS === 'string'
    || Array.isArray(patch.REDDIT_ALLOWED_SUBS)
    || patch.REDDIT_ALLOWED_SUBS instanceof Set
  ) {
    config.REDDIT_ALLOWED_SUBS = toSubSet(
      patch.REDDIT_ALLOWED_SUBS as string | string[] | Set<string>,
      [...config.REDDIT_ALLOWED_SUBS].join(',')
    );
  }
  if (typeof patch.REDDIT_SORT === 'string') config.REDDIT_SORT = patch.REDDIT_SORT;
  if (typeof patch.REDDIT_LIMIT === 'number' && Number.isFinite(patch.REDDIT_LIMIT)) config.REDDIT_LIMIT = patch.REDDIT_LIMIT;
  if (typeof patch.OPENAI_API_KEY === 'string') config.OPENAI_API_KEY = patch.OPENAI_API_KEY;
  if (typeof patch.OPENAI_MODEL === 'string') config.OPENAI_MODEL = patch.OPENAI_MODEL;
  if (typeof patch.OPENAI_IMAGE_MODEL === 'string') config.OPENAI_IMAGE_MODEL = patch.OPENAI_IMAGE_MODEL;
  if (typeof patch.OPENAI_IMAGE_TIMEOUT_MS === 'number' && Number.isFinite(patch.OPENAI_IMAGE_TIMEOUT_MS)) {
    config.OPENAI_IMAGE_TIMEOUT_MS = patch.OPENAI_IMAGE_TIMEOUT_MS;
  }
  if (typeof patch.AI_STYLE === 'string') config.AI_STYLE = patch.AI_STYLE;
  if (typeof patch.CUSTOM_PROMPT === 'string') config.CUSTOM_PROMPT = patch.CUSTOM_PROMPT;
  if (typeof patch.ENABLE_LINKEDIN === 'boolean') config.ENABLE_LINKEDIN = patch.ENABLE_LINKEDIN;
  if (typeof patch.ENABLE_X === 'boolean') config.ENABLE_X = patch.ENABLE_X;
  if (typeof patch.META_ACCESS_TOKEN === 'string') config.META_ACCESS_TOKEN = patch.META_ACCESS_TOKEN;
  if (typeof patch.META_GRAPH_VERSION === 'string') config.META_GRAPH_VERSION = patch.META_GRAPH_VERSION;
  if (typeof patch.THREADS_GRAPH_VERSION === 'string') config.THREADS_GRAPH_VERSION = patch.THREADS_GRAPH_VERSION;
  if (typeof patch.ENABLE_THREADS === 'boolean') config.ENABLE_THREADS = patch.ENABLE_THREADS;
  if (typeof patch.ENABLE_INSTAGRAM === 'boolean') config.ENABLE_INSTAGRAM = patch.ENABLE_INSTAGRAM;
  if (typeof patch.ENABLE_FACEBOOK === 'boolean') config.ENABLE_FACEBOOK = patch.ENABLE_FACEBOOK;
  if (typeof patch.LINKEDIN_TOKEN === 'string') config.LINKEDIN_TOKEN = patch.LINKEDIN_TOKEN;
  if (typeof patch.LINKEDIN_PERSON_URN === 'string') config.LINKEDIN_PERSON_URN = patch.LINKEDIN_PERSON_URN;
  if (typeof patch.X_API_KEY === 'string') config.X_API_KEY = patch.X_API_KEY;
  if (typeof patch.X_API_SECRET === 'string') config.X_API_SECRET = patch.X_API_SECRET;
  if (typeof patch.X_ACCESS_TOKEN === 'string') config.X_ACCESS_TOKEN = patch.X_ACCESS_TOKEN;
  if (typeof patch.X_ACCESS_TOKEN_SECRET === 'string') config.X_ACCESS_TOKEN_SECRET = patch.X_ACCESS_TOKEN_SECRET;
  if (typeof patch.X_OAUTH2_ACCESS_TOKEN === 'string') config.X_OAUTH2_ACCESS_TOKEN = patch.X_OAUTH2_ACCESS_TOKEN;
  if (typeof patch.X_OAUTH2_REFRESH_TOKEN === 'string') config.X_OAUTH2_REFRESH_TOKEN = patch.X_OAUTH2_REFRESH_TOKEN;
  if (typeof patch.X_CLIENT_ID === 'string') config.X_CLIENT_ID = patch.X_CLIENT_ID;
  if (typeof patch.X_CLIENT_SECRET === 'string') config.X_CLIENT_SECRET = patch.X_CLIENT_SECRET;
  if (typeof patch.X_REDIRECT_URI === 'string') config.X_REDIRECT_URI = patch.X_REDIRECT_URI;
  if (typeof patch.THREADS_ACCESS_TOKEN === 'string') config.THREADS_ACCESS_TOKEN = patch.THREADS_ACCESS_TOKEN;
  if (typeof patch.THREADS_USER_ID === 'string') config.THREADS_USER_ID = patch.THREADS_USER_ID;
  if (typeof patch.FACEBOOK_PAGE_ACCESS_TOKEN === 'string') config.FACEBOOK_PAGE_ACCESS_TOKEN = patch.FACEBOOK_PAGE_ACCESS_TOKEN;
  if (typeof patch.INSTAGRAM_ACCOUNT_ID === 'string') config.INSTAGRAM_ACCOUNT_ID = patch.INSTAGRAM_ACCOUNT_ID;
  if (typeof patch.FACEBOOK_GROUP_ID === 'string') config.FACEBOOK_GROUP_ID = patch.FACEBOOK_GROUP_ID;
  if (typeof patch.FACEBOOK_USER_ID === 'string') config.FACEBOOK_USER_ID = patch.FACEBOOK_USER_ID;
  if (typeof patch.FACEBOOK_PAGE_ID === 'string') config.FACEBOOK_PAGE_ID = patch.FACEBOOK_PAGE_ID;
  if (typeof patch.CLOUDINARY_CLOUD_NAME === 'string') config.CLOUDINARY_CLOUD_NAME = patch.CLOUDINARY_CLOUD_NAME;
  if (typeof patch.CLOUDINARY_API_KEY === 'string') config.CLOUDINARY_API_KEY = patch.CLOUDINARY_API_KEY;
  if (typeof patch.CLOUDINARY_API_SECRET === 'string') config.CLOUDINARY_API_SECRET = patch.CLOUDINARY_API_SECRET;
  if (typeof patch.CLOUDINARY_UPLOAD_PRESET === 'string') config.CLOUDINARY_UPLOAD_PRESET = patch.CLOUDINARY_UPLOAD_PRESET;
  if (typeof patch.CLOUDINARY_FOLDER === 'string') config.CLOUDINARY_FOLDER = patch.CLOUDINARY_FOLDER;
  if (typeof patch.TIMEZONE === 'string') config.TIMEZONE = patch.TIMEZONE;
  if (typeof patch.APP_DATA_DIR === 'string') config.APP_DATA_DIR = patch.APP_DATA_DIR;

  return config;
}

export function reloadRuntimeConfigFromStorage(): AppConfig {
  if (IS_CLOUDFLARE_WORKER) {
    return config;
  }

  const { getStoredRuntimeConfigPatch } = require('./src/control-plane') as typeof import('./src/control-plane');
  return applyRuntimeConfig(getStoredRuntimeConfigPatch());
}

reloadRuntimeConfigFromStorage();

export function validateProductionConfig(current = config): string[] {
  const issues: string[] = [];

  if (current.NODE_ENV === 'production') {
    if (!parseBooleanEnv(process.env.COOKIE_SECURE, false)) {
      issues.push('COOKIE_SECURE must be true in production');
    }
    if (!process.env.APP_ENCRYPTION_KEY?.trim()) {
      issues.push('APP_ENCRYPTION_KEY must be set in production');
    }
    if (!current.APP_DATA_DIR.trim()) {
      issues.push('APP_DATA_DIR must be set in production');
    }
    if (current.BOOTSTRAP_MODE !== 'disabled' && current.BOOTSTRAP_MODE !== 'token') {
      issues.push('BOOTSTRAP_MODE must be disabled or token in production');
    }
    if (current.BOOTSTRAP_MODE === 'token' && !current.BOOTSTRAP_TOKEN.trim()) {
      issues.push('BOOTSTRAP_TOKEN is required when BOOTSTRAP_MODE=token');
    }
    if (current.BILLING_BYPASS_FOR_LOCAL_DEV) {
      issues.push('BILLING_BYPASS_FOR_LOCAL_DEV must be false in production');
    }
  }

  if (current.SUPABASE_URL || current.SUPABASE_SERVICE_ROLE_KEY || current.CREDENTIAL_ENCRYPTION_KEY) {
    if (!current.SUPABASE_URL.trim()) {
      issues.push('SUPABASE_URL is required when Supabase worker credentials are configured');
    }
    if (!current.SUPABASE_SERVICE_ROLE_KEY.trim()) {
      issues.push('SUPABASE_SERVICE_ROLE_KEY, SUPABASE_SECRET_KEY, or SERVICE_ROLE_KEY is required when Supabase worker credentials are configured');
    }
    if (!current.CREDENTIAL_ENCRYPTION_KEY.trim()) {
      issues.push('CREDENTIAL_ENCRYPTION_KEY is required when Supabase worker credentials are configured');
    }
  }

  return issues;
}

export default config;
