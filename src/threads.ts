import config from '../config';
import { requestJson } from './http-client';
import {
  PlatformPublishError,
  safeBodySnippet,
} from './platform-errors';
import { assertCanonicalMetaPublicationPath } from './meta-publication-boundary';

interface ThreadsTokenResponse extends GraphErrorResponse {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
}

interface ThreadsMeResponse extends GraphErrorResponse {
  id?: string;
  username?: string;
}

export interface ThreadsTokenSet {
  accessToken: string;
  expiresIn?: number;
  tokenType?: string;
  source: 'exchange' | 'refresh';
}

export interface ThreadsCredentialPreparation {
  action: 'exchanged' | 'refreshed' | 'verified';
  accountId: string;
  username?: string;
  expiresIn?: number;
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
    source: 'refresh',
  };
}

export async function exchangeShortLivedAccessToken(): Promise<ThreadsTokenSet> {
  const token = config.THREADS_ACCESS_TOKEN;
  if (!token) {
    throw new Error('THREADS_ACCESS_TOKEN not set');
  }
  if (!config.THREADS_APP_SECRET) {
    throw new Error('THREADS_APP_SECRET not set');
  }

  const url = new URL('https://graph.threads.net/access_token');
  url.searchParams.set('grant_type', 'th_exchange_token');
  url.searchParams.set('client_secret', config.THREADS_APP_SECRET);
  url.searchParams.set('access_token', token);

  const { status, headers, data, rawText } = await requestJson<ThreadsTokenResponse>(url.toString(), {
    method: 'GET',
    timeoutMs: config.HTTP_TIMEOUT_MS,
  });
  if (data.error) {
    throw normalizeThreadsError(
      'token_exchange',
      status,
      headers.get('content-type'),
      rawText,
      data.error
    );
  }
  if (status >= 400 || !data.access_token) {
    throw unexpectedThreadsResponse('token_exchange', status, headers.get('content-type'), rawText);
  }

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
    tokenType: data.token_type,
    source: 'exchange',
  };
}

export async function verifyCredentials(accessToken = config.THREADS_ACCESS_TOKEN): Promise<{
  accountId: string;
  username?: string;
}> {
  if (!accessToken) {
    throw new Error('THREADS_ACCESS_TOKEN not set');
  }

  const { status, headers, data, rawText } = await requestJson<ThreadsMeResponse>(
    'https://graph.threads.net/me?fields=id%2Cusername',
    {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${accessToken}` },
      timeoutMs: config.HTTP_TIMEOUT_MS,
    }
  );
  if (data.error) {
    throw normalizeThreadsError(
      'verify_credentials',
      status,
      headers.get('content-type'),
      rawText,
      data.error
    );
  }
  if (status >= 400 || !data.id) {
    throw unexpectedThreadsResponse('verify_credentials', status, headers.get('content-type'), rawText);
  }

  return {
    accountId: data.id,
    username: data.username,
  };
}

export async function verifyPublished(postId: string): Promise<{
  confirmed: boolean;
  providerResultId: string;
}> {
  const token = config.THREADS_ACCESS_TOKEN;
  if (!token) {
    throw new Error('THREADS_ACCESS_TOKEN not set');
  }
  const { status, headers, data, rawText } = await requestJson<ThreadsMeResponse>(
    `https://graph.threads.net/${encodeURIComponent(postId)}?fields=id`,
    {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
      timeoutMs: config.HTTP_TIMEOUT_MS,
    }
  );
  if (data.error) {
    throw normalizeThreadsError(
      'verify_action',
      status,
      headers.get('content-type'),
      rawText,
      data.error
    );
  }
  if (status >= 400 || !data.id) {
    throw unexpectedThreadsResponse('verify_action', status, headers.get('content-type'), rawText);
  }
  return { confirmed: data.id === postId, providerResultId: data.id };
}

export async function prepareAccessTokenForPublish(): Promise<ThreadsCredentialPreparation> {
  let tokens: ThreadsTokenSet | undefined;

  if (config.THREADS_APP_SECRET) {
    try {
      tokens = await exchangeShortLivedAccessToken();
    } catch {
      // A long-lived token cannot be exchanged again; try its refresh endpoint next.
    }
  }

  if (!tokens) {
    try {
      tokens = await refreshLongLivedAccessToken();
    } catch {
      // Fresh long-lived tokens cannot be refreshed for 24 hours. Verification below
      // distinguishes that valid state from an expired or revoked token.
    }
  }

  if (tokens) {
    await persistLongLivedAccessToken(tokens);
  }

  const verification = await verifyCredentials();
  return {
    action: tokens?.source === 'exchange'
      ? 'exchanged'
      : tokens?.source === 'refresh'
        ? 'refreshed'
        : 'verified',
    accountId: verification.accountId,
    username: verification.username,
    expiresIn: tokens?.expiresIn,
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

export async function publish(_text: string): Promise<string> {
  assertCanonicalMetaPublicationPath('threads');
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
      bodySnippet: safeBodySnippet({
        message: error.message,
        type: error.type,
        code: error.code,
        error_subcode: error.error_subcode,
      }),
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
    bodySnippet: stage.startsWith('token_') ? null : safeBodySnippet(rawText),
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
