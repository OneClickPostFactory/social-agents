import * as crypto from 'node:crypto';
import config from '../config';
import { requestJson } from './http-client';
import { PlatformPublishError, safeBodySnippet } from './platform-errors';

interface XApiErrorDetail {
  message?: string;
  detail?: string;
}

interface XApiErrorResponse {
  errors?: XApiErrorDetail[];
  error?: string;
  detail?: string;
  title?: string;
  status?: number;
  type?: string;
}

interface XMeResponse extends XApiErrorResponse {
  data?: {
    id: string;
    name?: string;
    username?: string;
  };
}

interface XPublishResponse extends XApiErrorResponse {
  data?: {
    id?: string;
    text?: string;
  };
}

interface XVerifyCredentialsResponse extends XApiErrorResponse {
  id?: string | number;
  id_str?: string;
  name?: string;
  screen_name?: string;
}

export interface XOAuth2TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  scope?: string;
  tokenType?: string;
}

type XOAuth2TokenPersistence = (tokens: XOAuth2TokenSet) => void | Promise<void>;

interface XOAuth2TokenResponse extends XApiErrorResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

export type XAuthMode = 'oauth1-user' | 'oauth2-user' | 'unconfigured';
export type XSafeAuthMode = 'x_oauth1_user_context' | 'x_oauth2_user_context' | 'unconfigured';
export type XErrorKind = 'publish-access-tier' | 'project-required' | 'auth' | 'other';

let persistOAuth2TokensHandler: XOAuth2TokenPersistence = persistOAuth2TokensToLocalRuntime;

function encodeOAuthComponent(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function hasOAuth1Config(): boolean {
  return Boolean(
    config.X_API_KEY
    && config.X_API_SECRET
    && config.X_ACCESS_TOKEN
    && config.X_ACCESS_TOKEN_SECRET
  );
}

function hasOAuth2Config(): boolean {
  return Boolean(config.X_OAUTH2_ACCESS_TOKEN);
}

function hasOAuth2RefreshConfig(): boolean {
  return Boolean(config.X_CLIENT_ID && config.X_CLIENT_SECRET && config.X_OAUTH2_REFRESH_TOKEN);
}

export function getConfiguredAuthMode(): XAuthMode {
  if (hasOAuth2RefreshConfig()) return 'oauth2-user';
  if (hasOAuth2Config()) return 'oauth2-user';
  if (hasOAuth1Config()) return 'oauth1-user';
  return 'unconfigured';
}

export function safeAuthMode(mode: XAuthMode = getConfiguredAuthMode()): XSafeAuthMode {
  if (mode === 'oauth1-user') return 'x_oauth1_user_context';
  if (mode === 'oauth2-user') return 'x_oauth2_user_context';
  return 'unconfigured';
}

export function classifyXError(message: string): XErrorKind {
  const normalized = message.toLowerCase();

  if (
    normalized.includes('limited v1.1 endpoints')
    || normalized.includes('different access level')
    || normalized.includes('subset of x api v2 endpoints')
  ) {
    return 'publish-access-tier';
  }

  if (
    normalized.includes('attached to a project')
    || normalized.includes('attached to an x project')
    || normalized.includes('not attached to an x project')
    || normalized.includes('associated to a project')
  ) {
    return 'project-required';
  }

  if (
    normalized.includes('forbidden for this endpoint')
    || normalized.includes('oauth 2.0 application-only')
    || normalized.includes('could not authenticate you')
    || normalized.includes('invalid or expired token')
    || normalized === 'unauthorized'
  ) {
    return 'auth';
  }

  return 'other';
}

export function isPublishCapabilityBlockedError(message: string): boolean {
  return classifyXError(message) === 'publish-access-tier';
}

function getOAuth2AccessToken(): string {
  if (!config.X_OAUTH2_ACCESS_TOKEN) {
    throw new Error('X_OAUTH2_ACCESS_TOKEN not set');
  }
  return config.X_OAUTH2_ACCESS_TOKEN;
}

function getOAuth2ClientBasicAuth(): string {
  if (!config.X_CLIENT_ID || !config.X_CLIENT_SECRET) {
    throw new Error('X_CLIENT_ID and X_CLIENT_SECRET are required for X OAuth 2.0 token exchange');
  }

  return 'Basic ' + Buffer
    .from(`${config.X_CLIENT_ID}:${config.X_CLIENT_SECRET}`)
    .toString('base64');
}

function getOAuth1Header(method: 'GET' | 'POST', path: string): string {
  const url = new URL(`https://api.x.com${path}`);
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: config.X_API_KEY,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: config.X_ACCESS_TOKEN,
    oauth_version: '1.0',
  };

  const normalizedParams = [
    ...Array.from(url.searchParams.entries()),
    ...Object.entries(oauthParams),
  ]
    .map(([key, value]) => [encodeOAuthComponent(key), encodeOAuthComponent(value)] as const)
    .sort((left, right) => {
      if (left[0] === right[0]) {
        return left[1].localeCompare(right[1]);
      }
      return left[0].localeCompare(right[0]);
    })
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  const signatureBase = [
    method,
    encodeOAuthComponent(`${url.origin}${url.pathname}`),
    encodeOAuthComponent(normalizedParams),
  ].join('&');

  const signingKey = `${encodeOAuthComponent(config.X_API_SECRET)}&${encodeOAuthComponent(config.X_ACCESS_TOKEN_SECRET)}`;
  const signature = crypto
    .createHmac('sha1', signingKey)
    .update(signatureBase)
    .digest('base64');

  const headerParams = {
    ...oauthParams,
    oauth_signature: signature,
  };

  return 'OAuth ' + Object.entries(headerParams)
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([key, value]) => `${encodeOAuthComponent(key)}="${encodeOAuthComponent(value)}"`)
    .join(', ');
}

function getErrorMessage(payload: XApiErrorResponse, statusCode?: number): string {
  if (payload.errors?.length) {
    return payload.errors
      .map(error => error.detail || error.message || 'Unknown error')
      .join(' | ');
  }

  if (payload.detail) {
    return payload.detail;
  }

  if (payload.error) {
    return payload.error;
  }

  if (payload.title) {
    return payload.title;
  }

  return statusCode ? `HTTP ${statusCode}` : 'Unknown error';
}

async function apiRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>
): Promise<T> {
  const payload = body ? JSON.stringify(body) : undefined;
  const authMode = getConfiguredAuthMode();

  if (authMode === 'unconfigured') {
    throw new PlatformPublishError({
      platform: 'x',
      stage: 'credential_check',
      code: 'not_connected',
      userMessage: 'X credentials are not connected. Add OAuth2 credentials and try again.',
      nextAction: 'Connect X in Credentials, then retry publish.',
      authMode: safeAuthMode(authMode),
    });
  }

  return apiRequestWithAuth<T>(method, path, authMode, payload);
}

async function apiRequestWithAuth<T>(
  method: 'GET' | 'POST',
  path: string,
  authMode: XAuthMode,
  payload?: string
): Promise<T> {
  if (authMode === 'unconfigured') {
    throw new PlatformPublishError({
      platform: 'x',
      stage: 'credential_check',
      code: 'not_connected',
      userMessage: 'X credentials are not connected. Add OAuth2 credentials and try again.',
      nextAction: 'Connect X in Credentials, then retry publish.',
      authMode: safeAuthMode(authMode),
    });
  }

  let token = authMode === 'oauth2-user'
    ? await getInitialOAuth2AccessToken()
    : undefined;

  let response = await sendApiRequest<T>(method, path, authMode, payload, token);
  if (
    authMode === 'oauth2-user'
    && hasOAuth2RefreshConfig()
    && classifyXError(response.message) === 'auth'
  ) {
    token = await refreshAndPersistOAuth2AccessToken();
    response = await sendApiRequest<T>(method, path, authMode, payload, token);
  }

  if (response.status === 401 || classifyXError(response.message) === 'auth') {
    throw new PlatformPublishError({
      platform: 'x',
      stage: payload ? 'post' : 'credential_check',
      code: 'needs_reconnect',
      userMessage: 'X credentials are invalid or expired. Reconnect X and try again.',
      nextAction: 'Reconnect X. The stored OAuth2 token cannot be used or refreshed.',
      authMode: safeAuthMode(authMode),
      status: response.status,
      contentType: response.contentType,
      providerCode: response.data.error || response.data.status || response.data.type || response.data.title || null,
      bodySnippet: safeBodySnippet(response.rawText),
    });
  }

  if (response.status >= 400 || response.data.errors || response.data.error || response.data.detail) {
    throw new Error('X API: ' + response.message);
  }

  return response.data;
}

async function sendApiRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  authMode: Exclude<XAuthMode, 'unconfigured'>,
  payload?: string,
  token?: string
): Promise<{ status: number; data: T & XApiErrorResponse; message: string; contentType: string | null; rawText: string }> {
  const { status, headers, data, rawText } = await requestJson<T & XApiErrorResponse>(`https://api.x.com${path}`, {
    method,
    headers: {
      'Authorization': authMode === 'oauth1-user'
        ? getOAuth1Header(method, path)
        : `Bearer ${token}`,
      ...(payload ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(payload ? { body: payload } : {}),
    timeoutMs: config.HTTP_TIMEOUT_MS,
  });

  return {
    status,
    data,
    message: getErrorMessage(data, status),
    contentType: headers.get('content-type'),
    rawText,
  };
}

async function getInitialOAuth2AccessToken(): Promise<string> {
  if (config.X_OAUTH2_ACCESS_TOKEN) {
    return config.X_OAUTH2_ACCESS_TOKEN;
  }

  if (hasOAuth2RefreshConfig()) {
    return refreshAndPersistOAuth2AccessToken();
  }

  return getOAuth2AccessToken();
}

async function refreshAndPersistOAuth2AccessToken(): Promise<string> {
  const tokens = await refreshOAuth2AccessToken(config.X_OAUTH2_REFRESH_TOKEN);
  await persistOAuth2Tokens(tokens);
  return getOAuth2AccessToken();
}

export async function getAuthenticatedUser(): Promise<{ id: string; username?: string; name?: string }> {
  if (getConfiguredAuthMode() === 'oauth1-user') {
    const response = await apiRequest<XVerifyCredentialsResponse>(
      'GET',
      '/1.1/account/verify_credentials.json?skip_status=true&include_entities=false'
    );
    const id = String(response.id_str || response.id || '');
    if (!id) {
      throw new Error('X API: verify_credentials returned no user id');
    }

    return {
      id,
      username: response.screen_name,
      name: response.name,
    };
  }

  const response = await apiRequest<XMeResponse>('GET', '/2/users/me?user.fields=id,name,username');
  if (!response.data?.id) {
    throw new Error('X API: Authenticated user lookup returned no id');
  }

  return response.data;
}

export async function verifyCredentials(): Promise<{
  authMode: XSafeAuthMode;
  accountId: string;
  username?: string;
  name?: string;
}> {
  const authMode = getConfiguredAuthMode();
  const user = await getAuthenticatedUser();
  return {
    authMode: safeAuthMode(authMode),
    accountId: user.id,
    username: user.username,
    name: user.name,
  };
}

export async function publish(text: string): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('X post text is empty');
  }

  if (trimmed.length > 280) {
    throw new Error('X post text exceeds 280 characters');
  }

  const response = await apiRequest<XPublishResponse>('POST', '/2/tweets', { text: trimmed });
  if (!response.data?.id) {
    throw new Error('X API: publish response returned no tweet id');
  }
  return response.data.id;
}

export function buildOAuth2AuthorizationUrl(state: string, codeChallenge: string, redirectUri = config.X_REDIRECT_URI): string {
  if (!config.X_CLIENT_ID) {
    throw new Error('X_CLIENT_ID not set');
  }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.X_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'tweet.read tweet.write users.read offline.access',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  return `https://twitter.com/i/oauth2/authorize?${params.toString()}`;
}

export function createOAuth2PkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(64).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');

  return { codeVerifier, codeChallenge };
}

export async function exchangeOAuth2Code(
  code: string,
  codeVerifier: string,
  redirectUri = config.X_REDIRECT_URI
): Promise<XOAuth2TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    client_id: config.X_CLIENT_ID,
  });

  return requestOAuth2Token(body);
}

export async function refreshOAuth2AccessToken(refreshToken: string): Promise<XOAuth2TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.X_CLIENT_ID,
  });

  return requestOAuth2Token(body);
}

async function requestOAuth2Token(body: URLSearchParams): Promise<XOAuth2TokenSet> {
  let { status, data } = await requestOAuth2TokenRequest(body, true);
  let message = getErrorMessage(data, status);

  if ((status >= 400 || data.errors || data.error || data.detail || !data.access_token) && message === 'unauthorized_client') {
    ({ status, data } = await requestOAuth2TokenRequest(body, false));
    message = getErrorMessage(data, status);
  }

  if ((status >= 400 || data.errors || data.error || data.detail || !data.access_token) && message === 'unauthorized_client') {
    const bodyWithSecret = new URLSearchParams(body);
    bodyWithSecret.set('client_secret', config.X_CLIENT_SECRET);
    ({ status, data } = await requestOAuth2TokenRequest(bodyWithSecret, false));
    message = getErrorMessage(data, status);
  }

  if (status === 401 || classifyXError(message) === 'auth') {
    const unauthorizedClient = message === 'unauthorized_client' || data.error === 'unauthorized_client';
    throw new PlatformPublishError({
      platform: 'x',
      stage: 'oauth_refresh',
      code: 'needs_reconnect',
      userMessage: unauthorizedClient
        ? 'X OAuth2 refresh failed because the client/token pair is invalid. Reconnect X.'
        : 'X credentials are invalid or expired. Reconnect X and try again.',
      nextAction: 'Reconnect X. The stored OAuth2 token cannot be used or refreshed.',
      authMode: safeAuthMode('oauth2-user'),
      status,
      providerCode: data.error || data.status || data.type || data.title || null,
      bodySnippet: safeBodySnippet(data),
    });
  }

  if (status >= 400 || data.errors || data.error || data.detail || !data.access_token) {
    throw new Error('X OAuth2: ' + message);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    scope: data.scope,
    tokenType: data.token_type,
  };
}

function requestOAuth2TokenRequest(
  body: URLSearchParams,
  useClientSecret: boolean
): Promise<{ status: number; data: XOAuth2TokenResponse }> {
  return requestJson<XOAuth2TokenResponse>('https://api.x.com/2/oauth2/token', {
    method: 'POST',
    headers: {
      ...(useClientSecret ? { 'Authorization': getOAuth2ClientBasicAuth() } : {}),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
    timeoutMs: config.HTTP_TIMEOUT_MS,
  });
}

function applyOAuth2TokensToConfig(tokens: XOAuth2TokenSet): Record<string, string> {
  const patch: Record<string, string> = {
    X_OAUTH2_ACCESS_TOKEN: tokens.accessToken,
  };

  config.X_OAUTH2_ACCESS_TOKEN = tokens.accessToken;

  if (tokens.refreshToken) {
    patch.X_OAUTH2_REFRESH_TOKEN = tokens.refreshToken;
    config.X_OAUTH2_REFRESH_TOKEN = tokens.refreshToken;
  }

  return patch;
}

function persistOAuth2TokensToLocalRuntime(tokens: XOAuth2TokenSet): void {
  const patch = applyOAuth2TokensToConfig(tokens);
  const { updateRuntimeSecrets } = require('./control-plane') as typeof import('./control-plane');
  updateRuntimeSecrets(patch);
}

export function setOAuth2TokenPersistence(handler: XOAuth2TokenPersistence): () => void {
  const previous = persistOAuth2TokensHandler;
  persistOAuth2TokensHandler = handler;
  return () => {
    persistOAuth2TokensHandler = previous;
  };
}

export async function persistOAuth2Tokens(tokens: XOAuth2TokenSet): Promise<void> {
  applyOAuth2TokensToConfig(tokens);
  await persistOAuth2TokensHandler(tokens);
}
