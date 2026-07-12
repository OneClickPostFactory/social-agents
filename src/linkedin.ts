import config from '../config';
import { isHttpError } from './errors';
import { requestJson } from './http-client';
import {
  isPlatformPublishError,
  PlatformPublishError,
  safeBodySnippet,
} from './platform-errors';

interface LinkedInPublishSuccess {
  id?: string;
}

interface LinkedInPublishError {
  message?: string;
  code?: string;
  serviceErrorCode?: number;
  status?: number;
}

interface LinkedInPublishResponse extends LinkedInPublishSuccess {
  message?: string;
}

interface LinkedInOAuthTokenResponse extends LinkedInPublishError {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

export interface LinkedInOAuthTokenSet {
  accessToken: string;
  expiresIn?: number;
  refreshToken?: string;
  refreshTokenExpiresIn?: number;
  scope?: string;
  tokenType?: string;
}

type LinkedInOAuthTokenPersistence = (
  tokens: LinkedInOAuthTokenSet
) => void | Promise<void>;

const REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
let persistOAuth2TokensHandler: LinkedInOAuthTokenPersistence = persistOAuth2TokensToLocalRuntime;

export function hasRefreshConfig(): boolean {
  return Boolean(
    config.LINKEDIN_REFRESH_TOKEN
    && config.LINKEDIN_CLIENT_ID
    && config.LINKEDIN_CLIENT_SECRET
  );
}

export function shouldRefreshAccessToken(
  expiresAt = config.LINKEDIN_EXPIRES_AT,
  nowMs = Date.now()
): boolean {
  if (!hasRefreshConfig()) return false;
  const expiresAtMs = Date.parse(expiresAt);
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs + REFRESH_WINDOW_MS;
}

export async function refreshOAuth2AccessToken(
  refreshToken = config.LINKEDIN_REFRESH_TOKEN
): Promise<LinkedInOAuthTokenSet> {
  if (!refreshToken || !config.LINKEDIN_CLIENT_ID || !config.LINKEDIN_CLIENT_SECRET) {
    throw new Error('LinkedIn refresh token, client ID, and client secret are required');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.LINKEDIN_CLIENT_ID,
    client_secret: config.LINKEDIN_CLIENT_SECRET,
  });
  const { status, headers, data, rawText } = await requestJson<LinkedInOAuthTokenResponse>(
    'https://www.linkedin.com/oauth/v2/accessToken',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      timeoutMs: config.HTTP_TIMEOUT_MS,
    }
  );

  if (status >= 400 || data.error || !data.access_token) {
    throw normalizeLinkedInOAuthError(
      status,
      headers.get('content-type'),
      rawText,
      data
    );
  }

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
    refreshToken: data.refresh_token,
    refreshTokenExpiresIn: data.refresh_token_expires_in,
    scope: data.scope,
    tokenType: data.token_type,
  };
}

export function setOAuth2TokenPersistence(handler: LinkedInOAuthTokenPersistence): () => void {
  const previous = persistOAuth2TokensHandler;
  persistOAuth2TokensHandler = handler;
  return () => {
    persistOAuth2TokensHandler = previous;
  };
}

export async function persistOAuth2Tokens(tokens: LinkedInOAuthTokenSet): Promise<void> {
  applyOAuth2TokensToConfig(tokens);
  await persistOAuth2TokensHandler(tokens);
}

export async function refreshAndPersistOAuth2AccessToken(): Promise<LinkedInOAuthTokenSet> {
  const tokens = await refreshOAuth2AccessToken();
  await persistOAuth2Tokens(tokens);
  return tokens;
}

function applyOAuth2TokensToConfig(tokens: LinkedInOAuthTokenSet): Record<string, string> {
  const patch: Record<string, string> = {
    LINKEDIN_TOKEN: tokens.accessToken,
  };
  config.LINKEDIN_TOKEN = tokens.accessToken;
  if (tokens.refreshToken) {
    config.LINKEDIN_REFRESH_TOKEN = tokens.refreshToken;
    patch.LINKEDIN_REFRESH_TOKEN = tokens.refreshToken;
  }
  return patch;
}

function persistOAuth2TokensToLocalRuntime(tokens: LinkedInOAuthTokenSet): void {
  const patch = applyOAuth2TokensToConfig(tokens);
  const { updateRuntimeSecrets } = require('./control-plane') as typeof import('./control-plane');
  updateRuntimeSecrets(patch);
}

export function publish(text: string): Promise<string> {
  if (!config.LINKEDIN_TOKEN || !config.LINKEDIN_PERSON_URN) {
    throw new Error('LINKEDIN_TOKEN or LINKEDIN_PERSON_URN not set');
  }

  if (!text || !text.trim()) {
    throw new Error('LinkedIn post text is empty');
  }

  const payload = JSON.stringify({
    author: config.LINKEDIN_PERSON_URN,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text },
        shareMediaCategory: 'NONE',
      },
    },
    visibility: {
      'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
    },
  });

  return requestJson<LinkedInPublishResponse>('https://api.linkedin.com/v2/ugcPosts', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.LINKEDIN_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
    },
    body: payload,
    timeoutMs: config.HTTP_TIMEOUT_MS,
  }).then(({ status, headers, data, rawText }) => {
    if (status === 201) {
      return data.id || 'posted';
    }
    throw normalizeLinkedInError('post', status, headers.get('content-type'), rawText, data);
  }).catch(error => {
    if (isPlatformPublishError(error)) throw error;
    if (isHttpError(error) && error.code === 'UPSTREAM_PARSE_ERROR') {
      throw new PlatformPublishError({
        platform: 'linkedin',
        stage: 'post',
        code: 'unexpected_response',
        userMessage: 'LinkedIn returned an unexpected response. Check token validity, permissions, and payload format.',
        nextAction: 'Reconnect LinkedIn or inspect Logs for the safe response details, then retry publish.',
        status: typeof error.details?.status === 'number' ? error.details.status : error.status,
        contentType: typeof error.details?.contentType === 'string' ? error.details.contentType : null,
        bodySnippet: typeof error.details?.bodySnippet === 'string' ? error.details.bodySnippet : null,
      });
    }
    throw error;
  });
}

function normalizeLinkedInOAuthError(
  status: number,
  contentType: string | null,
  rawText: string,
  data: LinkedInOAuthTokenResponse
): PlatformPublishError {
  const message = data.error_description || data.message || data.error || `HTTP ${status}`;
  const normalized = message.toLowerCase();
  const needsReconnect =
    status === 401
    || data.error === 'invalid_grant'
    || data.error === 'invalid_client'
    || normalized.includes('expired')
    || normalized.includes('revoked')
    || normalized.includes('invalid');

  return new PlatformPublishError({
    platform: 'linkedin',
    stage: 'oauth_refresh',
    code: needsReconnect ? 'needs_reconnect' : 'platform_api_error',
    userMessage: needsReconnect
      ? 'LinkedIn refresh credentials are invalid, expired, or revoked. Reconnect LinkedIn.'
      : 'LinkedIn could not refresh the access token.',
    nextAction: needsReconnect
      ? 'Reconnect LinkedIn and save a new access/refresh credential set.'
      : 'Open Logs for the safe LinkedIn refresh error, then retry.',
    status,
    contentType,
    providerCode: data.error || data.code || null,
    bodySnippet: safeBodySnippet({
      error: data.error,
      error_description: data.error_description,
      message: data.message,
      status,
    }),
  });
}

function normalizeLinkedInError(
  stage: string,
  status: number,
  contentType: string | null,
  rawText: string,
  data: LinkedInPublishError
): PlatformPublishError {
  const message = data.message || `HTTP ${status}`;
  const code = data.code || (data.serviceErrorCode ? String(data.serviceErrorCode) : undefined);
  if (status === 401 || data.code === 'INVALID_ACCESS_TOKEN') {
    return new PlatformPublishError({
      platform: 'linkedin',
      stage,
      code: 'needs_reconnect',
      userMessage: 'LinkedIn credentials are invalid or expired. Reconnect LinkedIn and try again.',
      nextAction: 'Reconnect LinkedIn in Credentials, then retry publish.',
      status,
      contentType,
      providerCode: code,
      bodySnippet: safeBodySnippet(rawText),
    });
  }

  return new PlatformPublishError({
    platform: 'linkedin',
    stage,
    code: status === 400 ? 'payload_rejected' : 'platform_api_error',
    userMessage: status === 400
      ? 'LinkedIn rejected the draft payload. Check text and account permissions.'
      : `LinkedIn API error: ${message}`,
    nextAction: 'Open Logs for the LinkedIn API details, then retry after fixing the account.',
    status,
    contentType,
    providerCode: code,
    bodySnippet: safeBodySnippet(rawText),
  });
}
