import config from '../config';

export type SupabaseFilterValue = string | number | boolean | null;

export interface SupabaseFilter {
  column: string;
  operator: 'eq' | 'neq' | 'in' | 'is' | 'gte' | 'lte';
  value: SupabaseFilterValue | SupabaseFilterValue[];
}

export interface SupabaseSelectOptions {
  select?: string;
  filters?: SupabaseFilter[];
  order?: string;
  limit?: number;
}

export interface SupabaseMutationOptions {
  filters?: SupabaseFilter[];
  returning?: boolean;
}

export class SupabaseRestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export class SupabaseNetworkError extends Error {
  constructor(
    message: string,
    public readonly table: string,
    public readonly operation: string,
    public readonly endpoint: string,
    public readonly causeDetails?: string
  ) {
    super(message);
  }
}

export function isSupabaseWorkerConfigured(): boolean {
  return Boolean(config.SUPABASE_URL && config.SUPABASE_SERVICE_ROLE_KEY && config.CREDENTIAL_ENCRYPTION_KEY);
}

export function assertSupabaseWorkerConfigured(): void {
  if (!config.SUPABASE_URL) {
    throw new Error('SUPABASE_URL is not configured');
  }
  if (!config.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY, SUPABASE_SECRET_KEY, or SERVICE_ROLE_KEY is not configured');
  }
  if (!config.CREDENTIAL_ENCRYPTION_KEY) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY is not configured');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function baseUrl(): string {
  assertSupabaseWorkerConfigured();
  return `${config.SUPABASE_URL.replace(/\/+$/, '')}/rest/v1`;
}

function endpointForLog(url: string | URL): string {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  return `${parsed.origin}${parsed.pathname}`;
}

function describeCause(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = typeof (cause as { code?: unknown }).code === 'string'
      ? ` ${String((cause as { code?: unknown }).code)}`
      : '';
    return `${cause.name}${code}: ${cause.message}`;
  }
  if (cause) return String(cause);
  return undefined;
}

async function fetchSupabase(url: string | URL, init: RequestInit, table: string, operation: string): Promise<Response> {
  const maxAttempts = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(config.HTTP_TIMEOUT_MS),
      });
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await sleep(500 * attempt);
      }
    }
  }

  const endpoint = endpointForLog(url);
  const causeDetails = describeCause(lastError);
  const suffix = causeDetails ? ` | cause: ${causeDetails}` : '';
  throw new SupabaseNetworkError(
    `Supabase ${operation} ${table} network request failed at ${endpoint} after ${maxAttempts} attempts${suffix}`,
    table,
    operation,
    endpoint,
    causeDetails
  );
}

function encodeFilterValue(value: SupabaseFilterValue | SupabaseFilterValue[]): string {
  if (Array.isArray(value)) {
    return `(${value.map(entry => String(entry)).join(',')})`;
  }
  if (value === null) return 'null';
  return String(value);
}

function addFilters(url: URL, filters: SupabaseFilter[] | undefined): void {
  for (const filter of filters || []) {
    url.searchParams.append(filter.column, `${filter.operator}.${encodeFilterValue(filter.value)}`);
  }
}

function serviceHeaders(extra?: Record<string, string>): Headers {
  assertSupabaseWorkerConfigured();
  const headers = new Headers(extra || {});
  headers.set('apikey', config.SUPABASE_SERVICE_ROLE_KEY);
  if (!config.SUPABASE_SERVICE_ROLE_KEY.startsWith('sb_')) {
    headers.set('Authorization', `Bearer ${config.SUPABASE_SERVICE_ROLE_KEY}`);
  }
  headers.set('Accept', 'application/json');
  return headers;
}

async function parseResponse<T>(response: Response, table: string): Promise<T> {
  const text = await response.text();
  const payload = text ? JSON.parse(text) as T : ([] as T);

  if (!response.ok) {
    const message = typeof payload === 'object' && payload && 'message' in payload
      ? String((payload as { message?: unknown }).message)
      : `Supabase ${table} request failed with HTTP ${response.status}`;
    throw new SupabaseRestError(message, response.status, payload);
  }

  return payload;
}

export async function supabaseSelect<T>(
  table: string,
  options: SupabaseSelectOptions = {}
): Promise<T[]> {
  const url = new URL(`${baseUrl()}/${table}`);
  url.searchParams.set('select', options.select || '*');
  if (options.order) url.searchParams.set('order', options.order);
  if (typeof options.limit === 'number') url.searchParams.set('limit', String(options.limit));
  addFilters(url, options.filters);

  const response = await fetchSupabase(url, {
    headers: serviceHeaders(),
  }, table, 'select');
  return parseResponse<T[]>(response, table);
}

export async function supabaseInsert<T>(
  table: string,
  body: Record<string, unknown> | Array<Record<string, unknown>>,
  returning = false
): Promise<T[]> {
  const url = `${baseUrl()}/${table}`;
  const response = await fetchSupabase(url, {
    method: 'POST',
    headers: serviceHeaders({
      'Content-Type': 'application/json',
      Prefer: returning ? 'return=representation' : 'return=minimal',
    }),
    body: JSON.stringify(body),
  }, table, 'insert');
  return parseResponse<T[]>(response, table);
}

export async function supabaseUpdate<T>(
  table: string,
  body: Record<string, unknown>,
  options: SupabaseMutationOptions = {}
): Promise<T[]> {
  const url = new URL(`${baseUrl()}/${table}`);
  addFilters(url, options.filters);
  const response = await fetchSupabase(url, {
    method: 'PATCH',
    headers: serviceHeaders({
      'Content-Type': 'application/json',
      Prefer: options.returning ? 'return=representation' : 'return=minimal',
    }),
    body: JSON.stringify(body),
  }, table, 'update');
  return parseResponse<T[]>(response, table);
}

export async function supabaseDelete<T>(
  table: string,
  options: SupabaseMutationOptions = {}
): Promise<T[]> {
  const url = new URL(`${baseUrl()}/${table}`);
  addFilters(url, options.filters);
  const response = await fetchSupabase(url, {
    method: 'DELETE',
    headers: serviceHeaders({
      Prefer: options.returning ? 'return=representation' : 'return=minimal',
    }),
  }, table, 'delete');
  return parseResponse<T[]>(response, table);
}
