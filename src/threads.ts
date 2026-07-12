import config from '../config';
import { isHttpError } from './errors';
import { requestJson } from './http-client';
import {
  isPlatformPublishError,
  PlatformPublishError,
  safeBodySnippet,
} from './platform-errors';

interface GraphSuccess {
  id: string;
}

interface ThreadsTokenResponse extends GraphErrorResponse {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
}

export interface ThreadsTokenSet {
  accessToken: string;
  expiresIn?: number;
  tokenType?: string;
}

type ThreadsTokenPersistence = (tokens: ThreadsTokenSet) => void | Promise<void>;

interface GraphErrorResponse {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
  id?: string;
}

let persistThreadsTokenHandler: ThreadsTokenPersistence = persistThreadsTokenToLocalRuntime;

export async function refreshLongLivedAccessToken(): Promise<ThreadsTokenSet> {
  const token = config.THREADS_ACCESS_TOKEN;
  if (!token) {
    throw new Error('THREADS_ACCESS_TOKEN not set');
  }

  const url = new URL('https://graph.threads.net/refresh_access_token');
  url.searchParams.set('grant_type', 'th_refresh_token');
  url.searchParams.set('access_token', token);

  const { status, headers, data, rawText } = await requestJson<ThreadsTokenResponse>(url.toString(), {
    method: 'GET',
    timeoutMs: config.HTTP_TIMEOUT_MS,
  });
  if (data.error) {
    throw normalizeThreadsError(
      'token_refresh',
      status,
      headers.get('content-type'),
      rawText,
      data.error
    );
  }
  if (status >= 400 || !data.access_token) {
    throw unexpectedThreadsResponse('token_refresh', status, headers.get('content-type'), rawText);
  }

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
    tokenType: data.token_type,
  };
}

export function setTokenPersistence(handler: ThreadsTokenPersistence): () => void {
  const previous = persistThreadsTokenHandler;
  persistThreadsTokenHandler = handler;
  return () => {
    persistThreadsTokenHandler = previous;
  };
}

export async function persistLongLivedAccessToken(tokens: ThreadsTokenSet): Promise<void> {
  config.THREADS_ACCESS_TOKEN = tokens.accessToken;
  await persistThreadsTokenHandler(tokens);
}

function persistThreadsTokenToLocalRuntime(tokens: ThreadsTokenSet): void {
  config.THREADS_ACCESS_TOKEN = tokens.accessToken;
  const { updateRuntimeSecrets } = require('./control-plane') as typeof import('./control-plane');
  updateRuntimeSecrets({ THREADS_ACCESS_TOKEN: tokens.accessToken });
}

export async function publish(text: string): Promise<string> {
  const token = config.THREADS_ACCESS_TOKEN;

  if (!token) {
    throw new Error('THREADS_ACCESS_TOKEN not set');
  }

  if (!text || !text.trim()) {
    throw new Error('Threads post text is empty');
  }

  const containerId = await apiPost(
    'container_create',
    '/me/threads',
    { media_type: 'TEXT', text, access_token: token }
  );

  await sleep(2000);

  return apiPost(
    'publish',
    '/me/threads_publish',
    { creation_id: containerId, access_token: token }
  );
}

async function apiPost(stage: string, pathname: string, params: Record<string, string>): Promise<string> {
  const token = params.access_token;
  const body = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'access_token'))
  ).toString();

  try {
    const { status, headers, data, rawText } = await requestJson<GraphErrorResponse & GraphSuccess>(
      `https://graph.threads.net${pathname}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        timeoutMs: config.HTTP_TIMEOUT_MS,
      }
    );

    if (data.error) {
      throw normalizeThreadsError(stage, status, headers.get('content-type'), rawText, data.error);
    }
    if (status >= 400 || !data.id) {
      throw unexpectedThreadsResponse(stage, status, headers.get('content-type'), rawText);
    }
    return data.id;
  } catch (error) {
    if (isPlatformPublishError(error)) throw error;
    if (isHttpError(error) && error.code === 'UPSTREAM_PARSE_ERROR') {
      throw unexpectedThreadsResponse(
        stage,
        typeof error.details?.status === 'number' ? error.details.status : error.status,
        typeof error.details?.contentType === 'string' ? error.details.contentType : null,
        typeof error.details?.bodySnippet === 'string' ? error.details.bodySnippet : ''
      );
    }
    throw error;
  }
}

function normalizeThreadsError(
  stage: string,
  status: number,
  contentType: string | null,
  rawText: string,
  error: NonNullable<GraphErrorResponse['error']>
): PlatformPublishError {
  const message = error.message || 'Unknown error';
  const normalized = message.toLowerCase();
  const providerCode = error.code ?? error.error_subcode ?? null;
  if (
    error.code === 190
    || normalized.includes('failed to decode')
    || normalized.includes('invalid')
    || normalized.includes('expired')
    || error.type === 'OAuthException'
  ) {
    return new PlatformPublishError({
      platform: 'threads',
      stage,
      code: 'needs_reconnect',
      userMessage: 'Threads credentials are invalid or expired. Reconnect Threads and try again.',
      nextAction: 'Reconnect Threads in Credentials, then retry publish.',
      status,
      contentType,
      providerCode,
      bodySnippet: safeBodySnippet(rawText),
    });
  }

  return new PlatformPublishError({
    platform: 'threads',
    stage,
    code: status === 400 ? 'payload_rejected' : 'platform_api_error',
    userMessage: status === 400
      ? 'Threads rejected the draft payload. Check text, media URL, and account permissions.'
      : `Threads API error: ${message}`,
    nextAction: status === 400
      ? 'Review the draft and account permissions, then retry publish.'
      : 'Open Logs for the Threads API details, then retry after fixing the account.',
    status,
    contentType,
    providerCode,
    bodySnippet: safeBodySnippet(rawText),
  });
}

function unexpectedThreadsResponse(stage: string, status: number, contentType: string | null, rawText: string): PlatformPublishError {
  return new PlatformPublishError({
    platform: 'threads',
    stage,
    code: 'unexpected_response',
    userMessage: 'Threads returned an unexpected response. Check token validity, permissions, and payload format.',
    nextAction: 'Reconnect Threads or inspect Logs for the safe response details, then retry publish.',
    status,
    contentType,
    bodySnippet: safeBodySnippet(rawText),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
