import type { AppRole } from './control-plane';
import type { PlatformKey, QueueItem, SlotId } from './types';

import { badRequest } from './errors';

type UnknownRecord = Record<string, unknown>;

const SLOT_IDS: SlotId[] = ['s1', 's2', 's3', 's4'];
const EDITABLE_SLOT_FIELDS: Array<keyof QueueItem> = [
  'title',
  'linkedin',
  'threads',
  'x',
  'instagram',
  'facebook',
  'imageUrl',
  'imagePrompt',
];

export function asObject(value: unknown, fieldName: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    badRequest(`${fieldName} must be an object`, 'INVALID_OBJECT');
  }
  return value as UnknownRecord;
}

export function optionalObject(value: unknown): UnknownRecord {
  if (!value) return {};
  return asObject(value, 'body');
}

export function asTrimmedString(value: unknown, fieldName: string, options?: {
  minLength?: number;
  maxLength?: number;
  allowEmpty?: boolean;
}): string {
  if (typeof value !== 'string') {
    badRequest(`${fieldName} must be a string`, 'INVALID_STRING');
  }

  const trimmed = value.trim();
  if (!options?.allowEmpty && !trimmed) {
    badRequest(`${fieldName} is required`, 'MISSING_FIELD');
  }
  if (options?.minLength && trimmed.length < options.minLength) {
    badRequest(`${fieldName} must be at least ${options.minLength} characters`, 'STRING_TOO_SHORT');
  }
  if (options?.maxLength && trimmed.length > options.maxLength) {
    badRequest(`${fieldName} must be at most ${options.maxLength} characters`, 'STRING_TOO_LONG');
  }

  return trimmed;
}

export function asOptionalTrimmedString(value: unknown, fieldName: string, maxLength?: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return asTrimmedString(value, fieldName, { maxLength });
}

export function asBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value !== 'boolean') {
    badRequest(`${fieldName} must be a boolean`, 'INVALID_BOOLEAN');
  }
  return value;
}

export function asOptionalBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined) return undefined;
  return asBoolean(value, fieldName);
}

export function asInteger(value: unknown, fieldName: string, options?: {
  min?: number;
  max?: number;
}): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    badRequest(`${fieldName} must be an integer`, 'INVALID_INTEGER');
  }
  if (options?.min !== undefined && value < options.min) {
    badRequest(`${fieldName} must be at least ${options.min}`, 'INTEGER_TOO_SMALL');
  }
  if (options?.max !== undefined && value > options.max) {
    badRequest(`${fieldName} must be at most ${options.max}`, 'INTEGER_TOO_LARGE');
  }
  return value;
}

export function asEnum<T extends string>(
  value: unknown,
  fieldName: string,
  allowed: readonly T[]
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    badRequest(`${fieldName} must be one of: ${allowed.join(', ')}`, 'INVALID_ENUM');
  }
  return value as T;
}

export function asStringArray(value: unknown, fieldName: string, options?: {
  maxItems?: number;
}): string[] {
  if (!Array.isArray(value)) {
    badRequest(`${fieldName} must be an array`, 'INVALID_ARRAY');
  }

  const items = value.map((item, index) => asTrimmedString(item, `${fieldName}[${index}]`));
  if (options?.maxItems !== undefined && items.length > options.maxItems) {
    badRequest(`${fieldName} must contain at most ${options.maxItems} items`, 'ARRAY_TOO_LARGE');
  }

  return items;
}

export function parseAuthCredentials(body: UnknownRecord): { email: string; password: string } {
  return {
    email: asTrimmedString(body.email, 'email', { minLength: 3, maxLength: 320 }),
    password: asTrimmedString(body.password, 'password', { minLength: 12, maxLength: 512 }),
  };
}

export function parsePasswordChange(body: UnknownRecord): { currentPassword: string; nextPassword: string } {
  return {
    currentPassword: asTrimmedString(body.currentPassword, 'currentPassword', { minLength: 12, maxLength: 512 }),
    nextPassword: asTrimmedString(body.nextPassword, 'nextPassword', { minLength: 12, maxLength: 512 }),
  };
}

export function parseTotp(body: UnknownRecord): { otp: string } {
  const otp = asTrimmedString(body.otp, 'otp', { minLength: 6, maxLength: 12 });
  if (!/^\d{6,12}$/.test(otp)) {
    badRequest('otp must contain digits only', 'INVALID_OTP');
  }
  return { otp };
}

export function parseSlotId(body: UnknownRecord): SlotId {
  return asEnum(body.slotId, 'slotId', SLOT_IDS);
}

export function parseCheckoutInterval(body: UnknownRecord): 'monthly' | 'yearly' {
  return asEnum(body.interval ?? 'monthly', 'interval', ['monthly', 'yearly']);
}

export function parseRole(value: unknown, fieldName = 'role'): AppRole {
  return asEnum(value, fieldName, ['owner', 'operator', 'viewer']);
}

export function parseUserCreate(body: UnknownRecord): {
  email: string;
  password: string;
  role: AppRole;
} {
  return {
    email: asTrimmedString(body.email, 'email', { minLength: 3, maxLength: 320 }),
    password: asTrimmedString(body.password, 'password', { minLength: 12, maxLength: 512 }),
    role: parseRole(body.role),
  };
}

export function parseUserUpdate(body: UnknownRecord): {
  userId: number;
  role?: AppRole;
  disabled?: boolean;
} {
  return {
    userId: asInteger(body.userId, 'userId', { min: 1 }),
    role: body.role === undefined ? undefined : parseRole(body.role),
    disabled: asOptionalBoolean(body.disabled, 'disabled'),
  };
}

export function parseUserPasswordReset(body: UnknownRecord): {
  userId: number;
  nextPassword: string;
} {
  return {
    userId: asInteger(body.userId, 'userId', { min: 1 }),
    nextPassword: asTrimmedString(body.nextPassword, 'nextPassword', { minLength: 12, maxLength: 512 }),
  };
}

export function parseSettingsPayload(body: UnknownRecord): UnknownRecord {
  return body.settings === undefined ? {} : asObject(body.settings, 'settings');
}

export function parseSecretsPayload(body: UnknownRecord): Record<string, string | null> {
  const secrets = body.secrets === undefined ? {} : asObject(body.secrets, 'secrets');
  const next: Record<string, string | null> = {};

  for (const [key, value] of Object.entries(secrets)) {
    if (value === null) {
      next[key] = null;
      continue;
    }
    if (typeof value !== 'string') {
      badRequest(`secrets.${key} must be a string or null`, 'INVALID_SECRET_FIELD');
    }
    next[key] = value;
  }

  return next;
}

export function parseRuntimeSettingsPatch(settings: UnknownRecord): UnknownRecord {
  const next: UnknownRecord = {};

  if ('REDDIT_USER' in settings) next.REDDIT_USER = asTrimmedString(settings.REDDIT_USER, 'settings.REDDIT_USER', { maxLength: 128 });
  if ('REDDIT_ALLOWED_SUBS' in settings) next.REDDIT_ALLOWED_SUBS = asStringArray(settings.REDDIT_ALLOWED_SUBS, 'settings.REDDIT_ALLOWED_SUBS', { maxItems: 50 });
  if ('REDDIT_SORT' in settings) next.REDDIT_SORT = asEnum(settings.REDDIT_SORT, 'settings.REDDIT_SORT', ['new', 'hot', 'top', 'rising']);
  if ('REDDIT_LIMIT' in settings) next.REDDIT_LIMIT = asInteger(settings.REDDIT_LIMIT, 'settings.REDDIT_LIMIT', { min: 1, max: 100 });
  if ('OPENAI_MODEL' in settings) next.OPENAI_MODEL = asTrimmedString(settings.OPENAI_MODEL, 'settings.OPENAI_MODEL', { maxLength: 128 });
  if ('AI_STYLE' in settings) next.AI_STYLE = asTrimmedString(settings.AI_STYLE, 'settings.AI_STYLE', { maxLength: 128 });
  if ('CUSTOM_PROMPT' in settings) next.CUSTOM_PROMPT = asTrimmedString(settings.CUSTOM_PROMPT, 'settings.CUSTOM_PROMPT', { allowEmpty: true, maxLength: 8000 });
  if ('ENABLE_LINKEDIN' in settings) next.ENABLE_LINKEDIN = asBoolean(settings.ENABLE_LINKEDIN, 'settings.ENABLE_LINKEDIN');
  if ('ENABLE_X' in settings) next.ENABLE_X = asBoolean(settings.ENABLE_X, 'settings.ENABLE_X');
  if ('ENABLE_THREADS' in settings) next.ENABLE_THREADS = asBoolean(settings.ENABLE_THREADS, 'settings.ENABLE_THREADS');
  if ('ENABLE_INSTAGRAM' in settings) next.ENABLE_INSTAGRAM = asBoolean(settings.ENABLE_INSTAGRAM, 'settings.ENABLE_INSTAGRAM');
  if ('ENABLE_FACEBOOK' in settings) next.ENABLE_FACEBOOK = asBoolean(settings.ENABLE_FACEBOOK, 'settings.ENABLE_FACEBOOK');
  if ('META_GRAPH_VERSION' in settings) next.META_GRAPH_VERSION = asTrimmedString(settings.META_GRAPH_VERSION, 'settings.META_GRAPH_VERSION', { maxLength: 32 });
  if ('THREADS_GRAPH_VERSION' in settings) next.THREADS_GRAPH_VERSION = asTrimmedString(settings.THREADS_GRAPH_VERSION, 'settings.THREADS_GRAPH_VERSION', { maxLength: 32 });
  if ('CLOUDINARY_FOLDER' in settings) next.CLOUDINARY_FOLDER = asTrimmedString(settings.CLOUDINARY_FOLDER, 'settings.CLOUDINARY_FOLDER', { allowEmpty: true, maxLength: 256 });
  if ('TIMEZONE' in settings) next.TIMEZONE = asTrimmedString(settings.TIMEZONE, 'settings.TIMEZONE', { maxLength: 128 });

  return next;
}

export function parseSlotUpdates(body: UnknownRecord): Partial<QueueItem> {
  const updates = body.updates === undefined ? {} : asObject(body.updates, 'updates');
  const next: Partial<QueueItem> = {};

  for (const [key, value] of Object.entries(updates)) {
    if (!EDITABLE_SLOT_FIELDS.includes(key as keyof QueueItem)) {
      badRequest(`updates.${key} is not editable`, 'UNSAFE_SLOT_FIELD');
    }

    if (typeof value !== 'string') {
      badRequest(`updates.${key} must be a string`, 'INVALID_SLOT_FIELD');
    }

    (next as Record<string, unknown>)[key] = value.trim();
  }

  return next;
}

export function pickPlatformDraftFields(item: QueueItem): Partial<Record<PlatformKey, string>> {
  return {
    linkedin: item.linkedin,
    threads: item.threads,
    x: item.x,
    instagram: item.instagram,
    facebook: item.facebook,
  };
}
