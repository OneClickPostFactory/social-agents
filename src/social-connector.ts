import * as crypto from 'node:crypto';

import config from '../config';

import * as facebook from './facebook';
import * as instagram from './instagram';
import * as threads from './threads';
import * as x from './x';
import { HttpError, isHttpError } from './errors';
import { isPlatformPublishError } from './platform-errors';
import {
  finalizeSocialAction,
  getSocialAction,
  listSocialActions,
  reserveSocialAction,
} from './store';

import type {
  SocialActionExecutionPath,
  SocialActionLedgerEntry,
  SocialActionStatus,
} from './store';

export type SocialConnectorPlatform = 'instagram' | 'facebook' | 'threads' | 'x';
export type SocialConnectorOperation = 'publish_post';
export type SocialConnectorCapability =
  | 'get_account'
  | 'publish_post'
  | 'verify_action';

export interface SocialConnectorAccountStatus {
  connector: 'social-agent';
  platform: SocialConnectorPlatform;
  accountKey: string;
  displayAccount: string;
  accountMapping: 'configured' | 'auto-discovery' | 'missing';
  enabled: boolean;
  authenticated: boolean | null;
  authenticationStatus: 'authenticated' | 'unauthenticated' | 'unknown';
  capabilities: SocialConnectorCapability[];
  unsupportedCapabilities: string[];
  executionPath: 'api';
  credentialStatus: 'available' | 'missing';
  permissionStatus: 'available' | 'unavailable' | 'unknown';
  verificationSupported: true;
  blocker?: string;
}

export interface SocialConnectorStatus {
  connector: 'social-agent';
  transport: 'unix-socket';
  healthy: boolean;
  writeDefault: 'dry-run';
  accounts: SocialConnectorAccountStatus[];
}

export type SocialExecutionPathClassification =
  | 'api-ready'
  | 'relay-only'
  | 'api-and-relay'
  | 'blocked';

export interface SocialConnectorExecuteRequest {
  liveSessionId: string;
  platform: SocialConnectorPlatform;
  accountKey: string;
  action: SocialConnectorOperation;
  targetId: string;
  text: string;
  imageUrl?: string;
  dryRun?: boolean;
  explicitWriteApproval?: boolean;
}

export interface SocialConnectorVerifyRequest {
  platform: SocialConnectorPlatform;
  accountKey: string;
  providerResultId: string;
  idempotencyKey?: string;
}

export interface SocialConnectorRelayLedgerRequest {
  phase: 'reserve' | 'success' | 'confirmed_failure' | 'ambiguous';
  liveSessionId: string;
  platform: SocialConnectorPlatform;
  accountKey: string;
  actionType: string;
  targetId: string;
  contentFingerprint?: string;
  providerResultId?: string;
  errorCategory?: string;
}

type AccountIdentity = {
  accountId: string;
  username?: string;
  name?: string;
};

type PlatformAdapter = {
  verifyCredentials(): Promise<AccountIdentity>;
  publish(text: string, imageUrl?: string): Promise<string>;
  verifyPublished(postId: string): Promise<{
    confirmed: boolean;
    providerResultId: string;
    permalink?: string;
  }>;
};

const RELAY_ONLY_CAPABILITIES = [
  'list_comments',
  'list_replies',
  'list_mentions',
  'list_notifications',
  'list_messages',
  'get_insights',
  'discover_public_content',
  'comment',
  'reply_to_comment',
  'send_message',
  'like',
  'unlike',
  'follow',
  'unfollow',
  'repost',
  'quote_post',
];

const adapters: Record<SocialConnectorPlatform, PlatformAdapter> = {
  instagram: {
    verifyCredentials: instagram.verifyCredentials,
    publish: (text, imageUrl) => instagram.publish(text, imageUrl || ''),
    verifyPublished: instagram.verifyPublished,
  },
  facebook: {
    verifyCredentials: facebook.verifyCredentials,
    publish: text => facebook.publish(text),
    verifyPublished: facebook.verifyPublished,
  },
  threads: {
    verifyCredentials: threads.verifyCredentials,
    publish: text => threads.publish(text),
    verifyPublished: threads.verifyPublished,
  },
  x: {
    verifyCredentials: x.verifyCredentials,
    publish: text => x.publish(text),
    verifyPublished: x.verifyPublished,
  },
};

function configuredAccountStatus(platform: SocialConnectorPlatform): SocialConnectorAccountStatus {
  const common = {
    connector: 'social-agent' as const,
    platform,
    authenticated: null,
    authenticationStatus: 'unknown' as const,
    capabilities: ['get_account', 'publish_post', 'verify_action'] as SocialConnectorCapability[],
    unsupportedCapabilities: [...RELAY_ONLY_CAPABILITIES],
    executionPath: 'api' as const,
    permissionStatus: 'unknown' as const,
    verificationSupported: true as const,
  };

  if (platform === 'instagram') {
    const mappedId = config.INSTAGRAM_ACCOUNT_ID || config.FACEBOOK_PAGE_ID;
    const credentialsAvailable = Boolean(
      (config.FACEBOOK_PAGE_ACCESS_TOKEN || config.META_ACCESS_TOKEN)
      && mappedId
    );
    return {
      ...common,
      accountKey: `instagram:${config.INSTAGRAM_ACCOUNT_ID || 'page-linked'}`,
      displayAccount: config.INSTAGRAM_ACCOUNT_ID
        ? `Instagram account ${config.INSTAGRAM_ACCOUNT_ID}`
        : 'Page-linked Instagram account',
      accountMapping: config.INSTAGRAM_ACCOUNT_ID
        ? 'configured'
        : config.FACEBOOK_PAGE_ID
          ? 'auto-discovery'
          : 'missing',
      enabled: config.ENABLE_INSTAGRAM,
      credentialStatus: credentialsAvailable ? 'available' : 'missing',
      ...(credentialsAvailable ? {} : { blocker: 'Instagram account mapping or Meta credential is missing' }),
    };
  }

  if (platform === 'facebook') {
    const credentialsAvailable = Boolean(config.FACEBOOK_GROUP_ID && config.META_ACCESS_TOKEN);
    return {
      ...common,
      accountKey: `facebook:${config.FACEBOOK_GROUP_ID || 'unmapped'}`,
      displayAccount: config.FACEBOOK_GROUP_ID
        ? `Facebook Group ${config.FACEBOOK_GROUP_ID}`
        : 'Facebook Group not mapped',
      accountMapping: config.FACEBOOK_GROUP_ID ? 'configured' : 'missing',
      enabled: config.ENABLE_FACEBOOK,
      credentialStatus: credentialsAvailable ? 'available' : 'missing',
      ...(credentialsAvailable ? {} : { blocker: 'Facebook Group mapping or Meta credential is missing' }),
    };
  }

  if (platform === 'threads') {
    const credentialsAvailable = Boolean(config.THREADS_ACCESS_TOKEN);
    return {
      ...common,
      accountKey: `threads:${config.THREADS_USER_ID || 'configured-user'}`,
      displayAccount: config.THREADS_USER_ID
        ? `Threads account ${config.THREADS_USER_ID}`
        : 'Configured Threads user',
      accountMapping: config.THREADS_USER_ID ? 'configured' : credentialsAvailable ? 'auto-discovery' : 'missing',
      enabled: config.ENABLE_THREADS,
      credentialStatus: credentialsAvailable ? 'available' : 'missing',
      ...(credentialsAvailable ? {} : { blocker: 'Threads credential is missing' }),
    };
  }

  const credentialsAvailable = x.getConfiguredAuthMode() !== 'unconfigured';
  return {
    ...common,
    accountKey: 'x:configured-user',
    displayAccount: 'Configured X user',
    accountMapping: credentialsAvailable ? 'auto-discovery' : 'missing',
    enabled: config.ENABLE_X,
    credentialStatus: credentialsAvailable ? 'available' : 'missing',
    ...(credentialsAvailable ? {} : { blocker: 'X user-context OAuth credential is missing' }),
  };
}

function displayIdentity(platform: SocialConnectorPlatform, identity: AccountIdentity): string {
  if (identity.username) return `@${identity.username}`;
  if (identity.name) return identity.name;
  return `${platform} account ${identity.accountId}`;
}

function safeErrorCategory(error: unknown): {
  status: SocialActionStatus;
  category: string;
} {
  if (isPlatformPublishError(error)) {
    if (error.status === 429) return { status: 'rate_limited', category: 'rate_limited' };
    if (error.code === 'needs_reconnect' || error.code === 'not_connected') {
      return { status: 'authentication_failure', category: error.code };
    }
    if (/permission|scope|app.review/i.test(`${error.code} ${error.userMessage}`)) {
      return { status: 'permission_failure', category: 'permission_failure' };
    }
    return { status: 'confirmed_failure', category: error.code || 'platform_api_error' };
  }
  if (isHttpError(error)) {
    if (error.code === 'UPSTREAM_TIMEOUT') return { status: 'ambiguous', category: 'upstream_timeout' };
    if (error.status === 429) return { status: 'rate_limited', category: 'rate_limited' };
    if (error.status === 401) return { status: 'authentication_failure', category: 'authentication_failure' };
    if (error.status === 403) return { status: 'permission_failure', category: 'permission_failure' };
    return { status: 'confirmed_failure', category: error.code || 'upstream_failure' };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/abort|timed?.out|timeout/i.test(message)) {
    return { status: 'ambiguous', category: 'upstream_timeout' };
  }
  if (/permission|scope|app.review/i.test(message)) {
    return { status: 'permission_failure', category: 'permission_failure' };
  }
  if (/auth|token|credential|reconnect|expired|revoked|unauthorized/i.test(message)) {
    return { status: 'authentication_failure', category: 'authentication_failure' };
  }
  if (/rate.limit|too.many.requests|429/i.test(message)) {
    return { status: 'rate_limited', category: 'rate_limited' };
  }
  return { status: 'confirmed_failure', category: 'platform_api_error' };
}

function contentFingerprint(text: string): string {
  return crypto.createHash('sha256').update(text.trim()).digest('hex');
}

export function classifySocialExecutionPath(input: {
  connectorAvailable: boolean;
  relayAvailable: boolean;
  operationSupported: boolean;
}): SocialExecutionPathClassification {
  const apiUsable = input.connectorAvailable && input.operationSupported;
  if (apiUsable && input.relayAvailable) return 'api-and-relay';
  if (apiUsable) return 'api-ready';
  if (input.relayAvailable) return 'relay-only';
  return 'blocked';
}

export function socialActionIdempotencyKey(input: {
  platform: SocialConnectorPlatform;
  accountKey: string;
  actionType: string;
  targetId: string;
  contentFingerprint?: string;
}): string {
  return crypto
    .createHash('sha256')
    .update([
      input.platform,
      input.accountKey,
      input.actionType,
      input.targetId,
      input.contentFingerprint || '',
    ].join('\u001f'))
    .digest('hex');
}

function assertAccountMatch(platform: SocialConnectorPlatform, accountKey: string): SocialConnectorAccountStatus {
  const account = configuredAccountStatus(platform);
  if (account.accountKey !== accountKey) {
    throw new HttpError(400, 'The requested account does not match the configured connector account', {
      code: 'ACCOUNT_MAPPING_MISMATCH',
    });
  }
  return account;
}

export async function getSocialConnectorStatus(options: {
  verifyAuth?: boolean;
} = {}): Promise<SocialConnectorStatus> {
  const accounts = await Promise.all(
    (['instagram', 'facebook', 'threads', 'x'] as SocialConnectorPlatform[]).map(async platform => {
      const account = configuredAccountStatus(platform);
      if (!options.verifyAuth || account.credentialStatus === 'missing' || !account.enabled) {
        return account;
      }
      try {
        const identity = await adapters[platform].verifyCredentials();
        return {
          ...account,
          displayAccount: displayIdentity(platform, identity),
          authenticated: true,
          authenticationStatus: 'authenticated' as const,
          permissionStatus: 'available' as const,
        };
      } catch (error) {
        const classified = safeErrorCategory(error);
        return {
          ...account,
          authenticated: false,
          authenticationStatus: 'unauthenticated' as const,
          permissionStatus: classified.status === 'permission_failure'
            ? 'unavailable' as const
            : 'unknown' as const,
          blocker: classified.category,
        };
      }
    })
  );

  return {
    connector: 'social-agent',
    transport: 'unix-socket',
    healthy: true,
    writeDefault: 'dry-run',
    accounts,
  };
}

function validatePublishRequest(
  request: SocialConnectorExecuteRequest
): { account: SocialConnectorAccountStatus; fingerprint: string } {
  if (!request.liveSessionId?.trim()) {
    throw new HttpError(400, 'liveSessionId is required', { code: 'LIVE_SESSION_REQUIRED' });
  }
  if (request.action !== 'publish_post') {
    throw new HttpError(400, 'Operation is not supported by this connector', {
      code: 'UNSUPPORTED_OPERATION',
    });
  }
  const account = assertAccountMatch(request.platform, request.accountKey);
  if (!account.enabled) {
    throw new HttpError(409, 'Platform is disabled', { code: 'PLATFORM_DISABLED' });
  }
  if (account.credentialStatus !== 'available') {
    throw new HttpError(409, 'Platform credential or account mapping is unavailable', {
      code: 'CONNECTOR_NOT_CONFIGURED',
    });
  }
  if (!request.targetId?.trim()) {
    throw new HttpError(400, 'targetId is required', { code: 'TARGET_REQUIRED' });
  }
  if (!request.text?.trim()) {
    throw new HttpError(400, 'Post text is required', { code: 'TEXT_REQUIRED' });
  }
  if (request.platform === 'x' && request.text.trim().length > 280) {
    throw new HttpError(400, 'X post text exceeds 280 characters', { code: 'TEXT_TOO_LONG' });
  }
  if (request.platform === 'instagram' && !request.imageUrl?.trim()) {
    throw new HttpError(400, 'Instagram publish_post requires imageUrl', {
      code: 'IMAGE_URL_REQUIRED',
    });
  }
  return { account, fingerprint: contentFingerprint(request.text) };
}

export async function executeSocialConnectorAction(
  request: SocialConnectorExecuteRequest
): Promise<Record<string, unknown>> {
  const { account, fingerprint } = validatePublishRequest(request);
  const dryRun = request.dryRun !== false;
  const idempotencyKey = socialActionIdempotencyKey({
    platform: request.platform,
    accountKey: request.accountKey,
    actionType: request.action,
    targetId: request.targetId,
    contentFingerprint: fingerprint,
  });

  if (dryRun) {
    return {
      connector: 'social-agent',
      outcome: 'validated',
      dryRun: true,
      platform: request.platform,
      accountKey: account.accountKey,
      action: request.action,
      targetId: request.targetId,
      idempotencyKey,
      externalWritePerformed: false,
      verificationSupported: true,
    };
  }

  if (request.explicitWriteApproval !== true) {
    throw new HttpError(400, 'A live write requires explicitWriteApproval=true', {
      code: 'EXPLICIT_WRITE_APPROVAL_REQUIRED',
    });
  }

  const reservation = reserveSocialAction({
    idempotencyKey,
    liveSessionId: request.liveSessionId,
    executionPath: 'api',
    platform: request.platform,
    accountKey: request.accountKey,
    actionType: request.action,
    targetId: request.targetId,
    contentFingerprint: fingerprint,
  });
  if (!reservation.reserved) {
    return {
      connector: 'social-agent',
      outcome: 'duplicate_blocked',
      externalWritePerformed: false,
      action: reservation.entry,
    };
  }

  let providerResultId: string;
  try {
    providerResultId = await adapters[request.platform].publish(
      request.text.trim(),
      request.imageUrl?.trim()
    );
  } catch (error) {
    const classified = safeErrorCategory(error);
    const entry = finalizeSocialAction(idempotencyKey, {
      status: classified.status,
      errorCategory: classified.category,
    });
    return {
      connector: 'social-agent',
      outcome: classified.status,
      externalWritePerformed: classified.status === 'ambiguous' ? 'unknown' : false,
      action: entry,
      errorCategory: classified.category,
      nextAction: classified.status === 'ambiguous'
        ? 'Verify provider state before retrying or using Browser Relay.'
        : 'Resolve the reported connector blocker before retrying.',
    };
  }

  try {
    const verification = await adapters[request.platform].verifyPublished(providerResultId);
    const entry = finalizeSocialAction(idempotencyKey, {
      status: verification.confirmed ? 'success' : 'ambiguous',
      providerResultId,
      errorCategory: verification.confirmed ? undefined : 'verification_mismatch',
      verified: verification.confirmed,
    });
    return {
      connector: 'social-agent',
      outcome: verification.confirmed ? 'success' : 'ambiguous',
      externalWritePerformed: true,
      action: entry,
      evidence: {
        providerResultId: verification.providerResultId,
        ...(verification.permalink ? { permalink: verification.permalink } : {}),
        verified: verification.confirmed,
      },
    };
  } catch (error) {
    const classified = safeErrorCategory(error);
    const entry = finalizeSocialAction(idempotencyKey, {
      status: 'ambiguous',
      providerResultId,
      errorCategory: `verification_${classified.category}`,
    });
    return {
      connector: 'social-agent',
      outcome: 'ambiguous',
      externalWritePerformed: true,
      action: entry,
      evidence: {
        providerResultId,
        verified: false,
      },
      errorCategory: `verification_${classified.category}`,
      nextAction: 'Verify provider state before retrying or using Browser Relay.',
    };
  }
}

export async function verifySocialConnectorAction(
  request: SocialConnectorVerifyRequest
): Promise<Record<string, unknown>> {
  assertAccountMatch(request.platform, request.accountKey);
  const verification = await adapters[request.platform].verifyPublished(request.providerResultId);
  const entry = request.idempotencyKey
    ? finalizeSocialAction(request.idempotencyKey, {
      status: verification.confirmed ? 'success' : 'confirmed_failure',
      providerResultId: verification.providerResultId,
      errorCategory: verification.confirmed ? undefined : 'verification_mismatch',
      verified: true,
    })
    : undefined;
  return {
    connector: 'social-agent',
    outcome: verification.confirmed ? 'success' : 'confirmed_failure',
    evidence: {
      providerResultId: verification.providerResultId,
      ...(verification.permalink ? { permalink: verification.permalink } : {}),
      verified: true,
    },
    ...(entry ? { action: entry } : {}),
  };
}

export function recordRelaySocialAction(
  request: SocialConnectorRelayLedgerRequest
): Record<string, unknown> {
  assertAccountMatch(request.platform, request.accountKey);
  const idempotencyKey = socialActionIdempotencyKey({
    platform: request.platform,
    accountKey: request.accountKey,
    actionType: request.actionType,
    targetId: request.targetId,
    contentFingerprint: request.contentFingerprint,
  });

  if (request.phase === 'reserve') {
    const reservation = reserveSocialAction({
      idempotencyKey,
      liveSessionId: request.liveSessionId,
      executionPath: 'relay',
      platform: request.platform,
      accountKey: request.accountKey,
      actionType: request.actionType,
      targetId: request.targetId,
      ...(request.contentFingerprint ? { contentFingerprint: request.contentFingerprint } : {}),
    });
    return {
      connector: 'social-agent',
      outcome: reservation.reserved ? 'reserved' : 'duplicate_blocked',
      proceed: reservation.reserved,
      action: reservation.entry,
    };
  }

  const existing = getSocialAction(idempotencyKey);
  if (!existing) {
    throw new HttpError(409, 'Relay action must be reserved before completion', {
      code: 'LEDGER_RESERVATION_REQUIRED',
    });
  }
  const status = request.phase === 'success'
    ? 'success'
    : request.phase;
  const entry = finalizeSocialAction(idempotencyKey, {
    status,
    providerResultId: request.providerResultId,
    errorCategory: request.errorCategory,
    verified: request.phase !== 'ambiguous',
  });
  return {
    connector: 'social-agent',
    outcome: status,
    action: entry,
  };
}

export function getSocialConnectorLedger(
  liveSessionId: string,
  limit = 100
): SocialActionLedgerEntry[] {
  return listSocialActions(liveSessionId, limit);
}

export const __test__ = {
  configuredAccountStatus,
  safeErrorCategory,
  adapters,
};
