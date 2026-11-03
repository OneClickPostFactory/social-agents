import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseControlledPublish, type ControlledPublish } from './controlled-publish';

export interface RelayAttempt {
  attemptId: string;
  dispatchOperationId: string;
}
export interface RelayScope {
  jobId: string;
  userId: string;
  queueId: string;
  accountId: string;
  generation: number;
  platform: 'threads';
  approvalHash: string;
}
export interface RelayReceipt extends RelayScope, RelayAttempt {
  externalPostId: string;
}
type Invoke = (tool: string, args: Record<string, unknown>) => Promise<any>;
interface Options {
  target: ControlledPublish;
  token: string;
  textHash: string;
  journalDir: string;
  invoke: Invoke;
  receiptsOnly?: boolean;
  now?: () => number;
}
interface Journal {
  schema: 'ocpf.controlled-threads-relay.v1';
  scope: RelayScope;
  textHash: string;
  attempt: RelayAttempt;
  reservedAt: string;
  state: 'reserved' | 'accepted' | 'confirmed';
  sessionId: string;
  contentFingerprint: string;
  idempotencyKey: string;
  expectedUsername: string;
  receipt?: RelayReceipt;
}
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const digest = (value: string) => createHash('sha256').update(value).digest();
const sha256 = (value: string) => digest(value).toString('hex');

function validShape(target: any): target is ControlledPublish {
  return target && [target.jobId, target.userId, target.queueId].every(
    value => typeof value === 'string' && uuid.test(value),
  ) && target.platform === 'threads'
    && typeof target.approvalHash === 'string' && /^[0-9a-f]{64}$/.test(target.approvalHash)
    && typeof target.accountId === 'string' && /^[0-9]{1,32}$/.test(target.accountId)
    && Number.isSafeInteger(target.generation) && target.generation > 0
    && Number.isSafeInteger(target.expiresAt) && target.expiresAt > 0;
}

/** Expired authority may start a receipt-only server, never a new sender. */
export function parseThreadsRelayTarget(raw: string, receiptsOnly = false): ControlledPublish {
  const target = receiptsOnly ? JSON.parse(raw) : parseControlledPublish(raw);
  if (!validShape(target)) throw Error('invalid_relay_scope');
  return target;
}

function scopeOf(target: ControlledPublish): RelayScope {
  return {
    jobId: target.jobId, userId: target.userId, queueId: target.queueId,
    accountId: target.accountId, generation: target.generation,
    platform: 'threads', approvalHash: target.approvalHash,
  };
}
function parseAttempt(input: unknown): RelayAttempt {
  const attempt = input as RelayAttempt;
  if (!attempt || ![attempt.attemptId, attempt.dispatchOperationId].every(
    value => typeof value === 'string' && uuid.test(value),
  ) || Object.keys(attempt).length !== 2) throw Error('relay_attempt_invalid');
  return { attemptId: attempt.attemptId, dispatchOperationId: attempt.dispatchOperationId };
}
function sessionFor(target: ControlledPublish, attempt: RelayAttempt): string {
  return 'rlbe_ocpf_' + target.jobId + '_' + target.approvalHash + '_' + attempt.attemptId + '_live';
}
function gatewayKey(fingerprint: string): string {
  return sha256(['relay-live-business-engagement', 'threads', 'threads:owner',
    'publish', 'account-feed', fingerprint].join('\u001f'));
}
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * The local record is a dispatch fence, not a substitute for the SaaS ledger.
 * An exclusive, durable reservation always precedes the one provider operation.
 * Missing/partial/uncertain receipts never authorise another send.
 */
export function createControlledThreadsRelay(options: Options) {
  const target = structuredClone(options.target);
  const scope = scopeOf(target);
  const now = options.now || Date.now;
  if (!validShape(target) || options.token.length < 32
      || !/^[0-9a-f]{64}$/.test(options.textHash) || !isAbsolute(options.journalDir)) {
    throw Error('invalid_relay_scope');
  }
  mkdirSync(options.journalDir, { recursive: true, mode: 0o700 });
  const directory = lstatSync(options.journalDir);
  if (!directory.isDirectory() || directory.isSymbolicLink()
      || (directory.mode & 0o077) !== 0) throw Error('relay_journal_permissions');
  // Persist the directory entries too, including a newly created parent chain.
  for (let directoryPath = options.journalDir;; directoryPath = dirname(directoryPath)) {
    syncDirectory(directoryPath);
    if (dirname(directoryPath) === directoryPath) break;
  }
  // A fresh expiry or a different attempt cannot create a second opportunity for this job.
  const journalPath = join(options.journalDir, target.jobId + '.json');

  function load(attempt?: RelayAttempt): Journal | null {
    let fd: number;
    try { fd = openSync(journalPath, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 8192) {
        throw Error('relay_journal_invalid');
      }
      const row = JSON.parse(readFileSync(fd, 'utf8')) as Journal;
      if (row.schema !== 'ocpf.controlled-threads-relay.v1'
          || !isDeepStrictEqual(row.scope, scope) || row.textHash !== options.textHash
          || !['reserved', 'accepted', 'confirmed'].includes(row.state)
          || (attempt && !isDeepStrictEqual(row.attempt, attempt))) {
        throw Error('relay_journal_scope_mismatch');
      }
      parseAttempt(row.attempt);
      if (row.sessionId !== sessionFor(target, row.attempt)
          || !/^[0-9a-f]{64}$/.test(row.contentFingerprint)
          || row.idempotencyKey !== gatewayKey(row.contentFingerprint)
          || typeof row.expectedUsername !== 'string' || !row.expectedUsername) {
        throw Error('relay_journal_scope_mismatch');
      }
      if (row.state === 'accepted' || row.state === 'confirmed') {
        const receipt = row.receipt;
        if (!receipt || !/^[0-9]{1,32}$/.test(receipt.externalPostId)
            || !isDeepStrictEqual(receipt, { ...scope, ...row.attempt, externalPostId: receipt.externalPostId })) {
          throw Error('relay_journal_receipt_invalid');
        }
      }
      return row;
    } finally { closeSync(fd); }
  }

  function reserve(attempt: RelayAttempt, fingerprint: string, username: string): Journal | RelayReceipt {
    const row: Journal = {
      schema: 'ocpf.controlled-threads-relay.v1', scope, textHash: options.textHash,
      attempt, reservedAt: new Date(now()).toISOString(), state: 'reserved',
      sessionId: sessionFor(target, attempt), contentFingerprint: fingerprint,
      idempotencyKey: gatewayKey(fingerprint), expectedUsername: username,
    };
    let fd: number;
    try {
      fd = openSync(journalPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      const existing = load(attempt);
      if (existing?.state === 'confirmed') return existing.receipt!;
      throw Error('relay_publication_unconfirmed');
    }
    try { writeFileSync(fd, JSON.stringify(row)); fsyncSync(fd); }
    finally { closeSync(fd); }
    syncDirectory(options.journalDir);
    return row;
  }

  function persist(row: Journal): void {
    const temporary = journalPath + '.' + randomUUID() + '.tmp';
    const fd = openSync(temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeFileSync(fd, JSON.stringify(row));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temporary, journalPath);
    syncDirectory(options.journalDir);
  }

  function assertSendingAuthority(): void {
    if (options.receiptsOnly || now() >= target.expiresAt) throw Error('controlled_publish_expired');
  }

  async function accountIdentity(): Promise<{ id: string; username: string }> {
    const accounts = await options.invoke('accounts', {
      platform: 'threads', relayAvailable: false, verifyAuth: true,
    });
    const account = accounts?.accounts?.find((entry: any) => entry.key === 'threads:owner');
    if (account?.authentication !== 'authenticated'
        || account.platform !== 'threads'
        || account.representedAccount?.id !== target.accountId
        || typeof account.representedAccount?.username !== 'string'
        || !account.representedAccount.username) throw Error('relay_destination_mismatch');
    return account.representedAccount;
  }

  function activityMatches(activity: any, row: Journal): boolean {
    return activity?.namespace === 'relay-live-business-engagement'
      && activity.platform === 'threads' && activity.accountKey === 'threads:owner'
      && activity.sessionId === row.sessionId && activity.action === 'publish'
      && activity.targetId === 'account-feed' && activity.contentFingerprint === row.contentFingerprint
      && activity.idempotencyKey === row.idempotencyKey && activity.status === 'success'
      && typeof activity.providerResultId === 'string' && /^[0-9]{1,32}$/.test(activity.providerResultId)
      && typeof activity.verifiedAt === 'string' && Number.isFinite(Date.parse(activity.verifiedAt));
  }

  function accept(row: Journal, id: string): Journal {
    const accepted: Journal = {
      ...row, state: 'accepted', receipt: { ...scope, ...row.attempt, externalPostId: id },
    };
    // Retain the observed external ID before any further network request.
    persist(accepted);
    return accepted;
  }

  async function verifyAccepted(row: Journal): Promise<RelayReceipt> {
    const account = await accountIdentity();
    if (account.username !== row.expectedUsername) throw Error('relay_destination_mismatch');
    const receipt = row.receipt!;
    const inspected = await options.invoke('inspect', {
      platform: 'threads', accountKey: 'threads:owner', objectId: receipt.externalPostId,
    });
    const post = inspected?.object;
    if (inspected?.namespace !== 'relay-live-business-engagement'
        || inspected.platform !== 'threads' || inspected.accountKey !== 'threads:owner'
        || post?.id !== receipt.externalPostId || typeof post.text !== 'string'
        || sha256(post.text) !== options.textHash || post.username !== row.expectedUsername) {
      throw Error('relay_readback_mismatch');
    }
    persist({ ...row, state: 'confirmed' });
    return receipt;
  }

  async function recoverReserved(row: Journal): Promise<RelayReceipt> {
    const account = await accountIdentity();
    if (account.username !== row.expectedUsername) throw Error('relay_destination_mismatch');
    // This path invokes only read-only tools. A missing or ambiguous external
    // receipt keeps the permanent reservation and can never trigger execute.
    const listed = await options.invoke('activity', { mode: 'list', sessionId: row.sessionId, limit: 100 });
    if (listed?.namespace !== 'relay-live-business-engagement' || !Array.isArray(listed.activities)) {
      throw Error('relay_publication_unconfirmed');
    }
    const matching = listed.activities.filter((activity: unknown) => activityMatches(activity, row));
    if (matching.length !== 1) throw Error('relay_publication_unconfirmed');
    return verifyAccepted(accept(row, matching[0].providerResultId));
  }

  async function handle(input: {
    action?: unknown; target?: unknown; text?: unknown; attempt?: unknown;
  }): Promise<RelayScope | RelayReceipt> {
    if (!input || !isDeepStrictEqual(input.target, target)) throw Error('relay_scope_mismatch');
    if (input.action === 'ready') {
      const existing = load();
      if (existing && existing.state !== 'confirmed') throw Error('relay_publication_unconfirmed');
      assertSendingAuthority();
      await accountIdentity();
      assertSendingAuthority();
      return { ...scope };
    }
    if (input.action !== 'publish' && input.action !== 'receipt') throw Error('relay_action_invalid');
    const attempt = parseAttempt(input.attempt);
    if (input.action === 'publish' && (typeof input.text !== 'string'
        || input.text !== input.text.trim() || sha256(input.text) !== options.textHash)) {
      throw Error('relay_text_mismatch');
    }
    const existing = load(attempt);
    if (existing?.state === 'confirmed') return existing.receipt!;
    if (existing?.state === 'accepted') return verifyAccepted(existing);
    if (input.action === 'receipt' && existing) return recoverReserved(existing);
    if (input.action === 'receipt' || existing) throw Error('relay_publication_unconfirmed');

    assertSendingAuthority();
    const account = await accountIdentity();
    assertSendingAuthority();
    const text = input.text as string;
    const fingerprint = sha256(['publish', 'account-feed', text, '', ''].join('\u001f').trim());
    const reservation = reserve(attempt, fingerprint, account.username);
    if ('externalPostId' in reservation) return reservation;
    assertSendingAuthority();
    const sessionId = reservation.sessionId;
    // Do not retry this invocation: the fence remains reserved on every failure.
    const result = await options.invoke('execute', {
      platform: 'threads', accountKey: 'threads:owner', action: 'publish',
      campaignLaneId: 'oneclickpostfactory', opportunityId: target.jobId,
      runtimeOwner: 'oneclickpostfactory', sessionId, text,
      dryRun: false, explicitWriteApproval: true,
    });
    const activity = result?.activity;
    const id = activity?.providerResultId;
    if (result?.namespace !== 'relay-live-business-engagement'
        || result.outcome !== 'success' || result.externalWritePerformed !== true
        || result.evidence?.verified !== true || typeof id !== 'string' || !/^[0-9]{1,32}$/.test(id)
        || result.evidence.providerResultId !== id
        || activity.namespace !== 'relay-live-business-engagement'
        || activity.platform !== 'threads' || activity.accountKey !== 'threads:owner'
        || activity.sessionId !== sessionId || activity.action !== 'publish'
        || activity.targetId !== 'account-feed' || activity.contentFingerprint !== fingerprint
        || activity.idempotencyKey !== reservation.idempotencyKey
        || activity.status !== 'success') throw Error('relay_receipt_scope_mismatch');

    const accepted = accept(reservation, id);
    return verifyAccepted(accepted);
  }

  function server(): Server {
    return createServer(async (request, response) => {
      response.setHeader('cache-control', 'no-store');
      response.setHeader('content-type', 'application/json');
      if (request.method !== 'POST' || request.url !== '/threads'
          || !timingSafeEqual(digest(request.headers.authorization || ''),
            digest('Bearer ' + options.token))) {
        response.writeHead(404); response.end(); return;
      }
      try {
        let body = '';
        request.setEncoding('utf8');
        for await (const chunk of request) {
          body += chunk;
          if (Buffer.byteLength(body, 'utf8') > 8192) throw Error('relay_request_too_large');
        }
        const result = await handle(JSON.parse(body));
        response.end(JSON.stringify(result));
      } catch {
        response.writeHead(409);
        response.end(JSON.stringify({ error: 'threads_relay_unconfirmed' }));
      }
    });
  }
  return { handle, server };
}
