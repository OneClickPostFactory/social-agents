import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import {
  createControlledThreadsRelay, parseThreadsRelayTarget, type RelayAttempt,
} from '../src/controlled-threads-relay';
import type { ControlledPublish } from '../src/controlled-publish';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const text = 'A bounded synthetic approval for relay recovery tests.';
const token = 'synthetic-relay-bearer-'.repeat(3);
const attempt: RelayAttempt = {
  attemptId: '44444444-4444-4444-8444-444444444444',
  dispatchOperationId: '55555555-5555-4555-8555-555555555555',
};
const target: ControlledPublish = {
  jobId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  queueId: '33333333-3333-4333-8333-333333333333',
  platform: 'threads', generation: 3, accountId: '12345',
  approvalHash: 'a'.repeat(64), expiresAt: Date.now() + 600_000,
};
const scope = {
  jobId: target.jobId, userId: target.userId, queueId: target.queueId,
  platform: 'threads', generation: target.generation, accountId: target.accountId,
  approvalHash: target.approvalHash,
};
type FakeOptions = {
  account?: string;
  modifyResult?: (result: any) => void;
  modifyPost?: (result: any) => void;
  beforeExecute?: () => Promise<void>;
  activities?: any[];
  loseExecuteResponse?: boolean;
  loseInspectResponse?: boolean;
};
async function fixture(work: (state: {
  dir: string;
  options: FakeOptions;
  calls: string[];
  make: (patch?: Partial<Parameters<typeof createControlledThreadsRelay>[0]>) => ReturnType<typeof createControlledThreadsRelay>;
  setTime: (value: number) => void;
}) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ocpf-relay-test-'));
  const options: FakeOptions = {};
  const calls: string[] = [];
  let clock = Date.now();
  const invoke = async (tool: string, args: Record<string, any>) => {
    calls.push(tool);
    if (tool === 'accounts') return {
      accounts: [{ key: 'threads:owner', platform: 'threads', authentication: 'authenticated',
        representedAccount: { id: options.account || target.accountId, username: 'synthetic_owner' } }],
    };
    if (tool === 'execute') {
      // Reservation exists and is private before the first external operation.
      const journal = JSON.parse(readFileSync(join(dir, target.jobId + '.json'), 'utf8'));
      assert.equal(journal.state, 'reserved');
      assert.deepEqual(journal.attempt, attempt);
      assert.equal(statSync(join(dir, target.jobId + '.json')).mode & 0o777, 0o600);
      assert.equal(args.text, text);
      assert.equal(args.dryRun, false);
      await options.beforeExecute?.();
      const result = {
        namespace: 'relay-live-business-engagement', outcome: 'success', externalWritePerformed: true,
        evidence: { verified: true, providerResultId: '987654321' },
        activity: {
          namespace: 'relay-live-business-engagement', status: 'success',
          verifiedAt: new Date().toISOString(),
          platform: 'threads', accountKey: 'threads:owner', action: 'publish',
          sessionId: args.sessionId, targetId: 'account-feed',
          contentFingerprint: hash(['publish', 'account-feed', text, '', ''].join('\u001f').trim()),
          providerResultId: '987654321',
          idempotencyKey: hash(['relay-live-business-engagement', 'threads', 'threads:owner',
            'publish', 'account-feed',
            hash(['publish', 'account-feed', text, '', ''].join('\u001f').trim())].join('\u001f')),
        },
      };
      options.modifyResult?.(result);
      if (options.loseExecuteResponse) {
        options.activities = [result.activity];
        throw Error('lost execute response after provider success');
      }
      return result;
    }
    if (tool === 'activity') return { namespace: 'relay-live-business-engagement', activities: options.activities || [] };
    if (tool === 'inspect') {
      if (options.loseInspectResponse) throw Error('lost readback response');
      assert.equal(args.objectId, '987654321');
      const result = {
        namespace: 'relay-live-business-engagement', platform: 'threads', accountKey: 'threads:owner',
        object: { id: '987654321', text, username: 'synthetic_owner' },
      };
      options.modifyPost?.(result);
      return result;
    }
    throw Error('unexpected tool');
  };
  const make = (patch: Partial<Parameters<typeof createControlledThreadsRelay>[0]> = {}) =>
    createControlledThreadsRelay({
      target, token, textHash: hash(text), journalDir: dir, invoke, now: () => clock, ...patch,
    });
  try { await work({ dir, options, calls, make, setTime: value => { clock = value; } }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  console.log('ok - ' + name);
}
const publish = { action: 'publish', target, text, attempt };
const receipt = { action: 'receipt', target, attempt };

async function main() {
  await test('ready verifies the destination without reserving or publishing', () => fixture(async state => {
    assert.deepEqual(await state.make().handle({ action: 'ready', target }), scope);
    assert.deepEqual(state.calls, ['accounts']);
    assert.deepEqual(readdirSync(state.dir), []);
  }));

  await test('independent concurrent relay instances reserve the operation only once', () => fixture(async state => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    state.options.beforeExecute = async () => { entered(); await blocked; };
    const first = state.make().handle(publish);
    await started;
    const second = state.make();
    await assert.rejects(second.handle(publish), /unconfirmed/);
    release();
    const result = await first;
    assert.deepEqual(result, { ...scope, ...attempt, externalPostId: '987654321' });
    assert.deepEqual(await second.handle(publish), result);
    assert.deepEqual(await second.handle(receipt), result);
    assert.equal(state.calls.filter(value => value === 'execute').length, 1);
  }));

  await test('lost HTTP reply is recovered from a durable receipt after restart and expiry', () => fixture(async state => {
    const result = await state.make().handle(publish);
    state.setTime(target.expiresAt + 1);
    const before = state.calls.length;
    const restarted = state.make({ receiptsOnly: true });
    assert.deepEqual(await restarted.handle(receipt), result);
    assert.equal(state.calls.length, before);
    await assert.rejects(restarted.handle({ action: 'ready', target }), /expired/);
    const stored = readFileSync(join(state.dir, target.jobId + '.json'), 'utf8');
    assert.ok(!stored.includes(token));
    assert.ok(!stored.includes(text));
    assert.equal(JSON.parse(stored).state, 'confirmed');
  }));

  await test('a crash after reservation remains fenced across restart and renewed authority', () => fixture(async state => {
    state.options.beforeExecute = async () => { throw Error('simulated lost provider response'); };
    await assert.rejects(state.make().handle(publish), /lost provider response/);
    state.options.beforeExecute = undefined;
    const renewed = { ...target, expiresAt: target.expiresAt + 10_000 };
    const restarted = state.make({ target: renewed });
    await assert.rejects(restarted.handle({ ...publish, target: renewed }), /unconfirmed/);
    await assert.rejects(restarted.handle({ ...receipt, target: renewed }), /unconfirmed/);
    assert.equal(state.calls.filter(value => value === 'execute').length, 1);
  }));

  await test('lost execute response recovers exact successful gateway activity without another execute', () => fixture(async state => {
    state.options.loseExecuteResponse = true;
    await assert.rejects(state.make().handle(publish), /lost execute response/);
    state.setTime(target.expiresAt + 1);
    const before = state.calls.filter(value => value === 'execute').length;
    const recovered = await state.make({ receiptsOnly: true }).handle(receipt);
    assert.deepEqual(recovered, { ...scope, ...attempt, externalPostId: '987654321' });
    assert.equal(state.calls.filter(value => value === 'execute').length, before);
    assert.equal(JSON.parse(readFileSync(join(state.dir, target.jobId + '.json'), 'utf8')).state, 'confirmed');
  }));

  await test('accepted provider ID survives readback failure and restart', () => fixture(async state => {
    state.options.loseInspectResponse = true;
    await assert.rejects(state.make().handle(publish), /lost readback response/);
    const accepted = JSON.parse(readFileSync(join(state.dir, target.jobId + '.json'), 'utf8'));
    assert.equal(accepted.state, 'accepted');
    assert.equal(accepted.receipt.externalPostId, '987654321');
    state.options.loseInspectResponse = false;
    state.setTime(target.expiresAt + 1);
    const result = await state.make({ receiptsOnly: true }).handle(receipt);
    assert.equal((result as any).externalPostId, '987654321');
    assert.equal(state.calls.filter(value => value === 'execute').length, 1);
  }));

  await test('gateway recovery rejects mismatched or unresolved ledger evidence without replay', () => fixture(async state => {
    state.options.loseExecuteResponse = true;
    await assert.rejects(state.make().handle(publish), /lost execute response/);
    const activity = structuredClone(state.options.activities![0]);
    for (const patch of [
      { sessionId: 'other-session' }, { contentFingerprint: 'b'.repeat(64) },
      { idempotencyKey: 'b'.repeat(64) }, { status: 'dispatched' }, { verifiedAt: null },
      { accountKey: 'threads:other' }, { providerResultId: '' },
    ]) {
      state.options.activities = [{ ...activity, ...patch }];
      await assert.rejects(state.make().handle(receipt), /unconfirmed/);
    }
    state.options.activities = [activity, activity];
    await assert.rejects(state.make().handle(receipt), /unconfirmed/);
    state.options.activities = [activity];
    state.options.account = '999999';
    await assert.rejects(state.make().handle(receipt), /destination_mismatch/);
    assert.equal(state.calls.filter(value => value === 'execute').length, 1);
  }));

  await test('a new grant cannot replay a confirmed job and returns its original attempt receipt', () => fixture(async state => {
    const result = await state.make().handle(publish);
    const renewed = { ...target, expiresAt: target.expiresAt + 10_000 };
    const renewedRelay = state.make({ target: renewed });
    assert.deepEqual(await renewedRelay.handle({ ...publish, target: renewed }), result);
    await assert.rejects(renewedRelay.handle(publish), /scope_mismatch/);
    assert.equal(state.calls.filter(value => value === 'execute').length, 1);
  }));

  await test('changed attempt, operation, approval or text cannot reuse an existing job reservation', () => fixture(async state => {
    const relay = state.make();
    await relay.handle(publish);
    for (const changed of [
      { ...attempt, attemptId: '66666666-6666-4666-8666-666666666666' },
      { ...attempt, dispatchOperationId: '77777777-7777-4777-8777-777777777777' },
    ]) await assert.rejects(relay.handle({ ...receipt, attempt: changed }), /scope_mismatch/);
    await assert.rejects(relay.handle({ ...publish, text: text + ' changed' }), /text_mismatch/);
    const changedTarget = { ...target, approvalHash: 'b'.repeat(64) };
    await assert.rejects(state.make({ target: changedTarget }).handle(
      { ...publish, target: changedTarget },
    ), /scope_mismatch/);
    assert.equal(state.calls.filter(value => value === 'execute').length, 1);
  }));

  await test('invalid scope, attempt or draft fail before any account call or reservation', () => fixture(async state => {
    const relay = state.make();
    for (const input of [
      { ...publish, target: { ...target, accountId: '999' } },
      { ...publish, text: text + '\n' },
      { ...publish, text: 'different approved text' },
      { ...publish, attempt: { ...attempt, attemptId: '*' } },
      { ...publish, attempt: { ...attempt, injected: true } },
      { ...publish, attempt: undefined },
    ]) await assert.rejects(relay.handle(input));
    assert.deepEqual(state.calls, []);
    assert.deepEqual(readdirSync(state.dir), []);
  }));

  await test('expired and receipt-only configurations cannot make a first send', () => fixture(async state => {
    state.setTime(target.expiresAt);
    await assert.rejects(state.make().handle(publish), /expired/);
    await assert.rejects(state.make().handle({ action: 'ready', target }), /expired/);
    state.setTime(target.expiresAt - 1000);
    await assert.rejects(state.make({ receiptsOnly: true }).handle(publish), /expired/);
    await assert.rejects(state.make().handle(receipt), /unconfirmed/);
    assert.deepEqual(state.calls, []);
    assert.deepEqual(readdirSync(state.dir), []);
    const expired = { ...target, expiresAt: Date.now() - 1 };
    assert.throws(() => parseThreadsRelayTarget(JSON.stringify(expired)), /expired/);
    assert.deepEqual(parseThreadsRelayTarget(JSON.stringify(expired), true), expired);
  }));

  await test('account change after readiness is rejected before external dispatch', () => fixture(async state => {
    const relay = state.make();
    await relay.handle({ action: 'ready', target });
    state.options.account = '999999';
    await assert.rejects(relay.handle(publish), /destination_mismatch/);
    assert.equal(state.calls.filter(value => value === 'execute').length, 0);
    assert.deepEqual(readdirSync(state.dir), []);
  }));

  await test('expiry during the account check stops dispatch', () => fixture(async state => {
    const invoke = async () => {
      state.setTime(target.expiresAt);
      return { accounts: [{ key: 'threads:owner', platform: 'threads', authentication: 'authenticated',
        representedAccount: { id: target.accountId, username: 'synthetic_owner' } }] };
    };
    await assert.rejects(state.make({ invoke }).handle(publish), /expired/);
    assert.deepEqual(readdirSync(state.dir), []);
  }));

  for (const field of ['sessionId', 'accountKey', 'targetId', 'contentFingerprint', 'providerResultId', 'idempotencyKey']) {
    await test('mismatched provider receipt ' + field + ' stays unknown and cannot resend', () => fixture(async state => {
      state.options.modifyResult = result => { result.activity[field] = 'wrong'; };
      await assert.rejects(state.make().handle(publish), /receipt_scope_mismatch/);
      await assert.rejects(state.make().handle(publish), /unconfirmed/);
      await assert.rejects(state.make().handle(receipt), /unconfirmed/);
      assert.equal(state.calls.filter(value => value === 'execute').length, 1);
    }));
  }
  for (const field of ['id', 'username', 'text']) {
    await test('mismatched independent readback ' + field + ' stays unknown and cannot resend', () => fixture(async state => {
      state.options.modifyPost = result => { result.object[field] = 'wrong'; };
      await assert.rejects(state.make().handle(publish), /readback_mismatch/);
      await assert.rejects(state.make().handle(publish), /readback_mismatch/);
      assert.equal(state.calls.filter(value => value === 'execute').length, 1);
    }));
  }

  await test('partial reservation left by a crash fails closed', () => fixture(async state => {
    writeFileSync(join(state.dir, target.jobId + '.json'), '', { mode: 0o600 });
    await assert.rejects(state.make().handle(publish));
    await assert.rejects(state.make().handle(receipt));
    assert.deepEqual(state.calls, []);
  }));

  await test('HTTP boundary rejects invalid bearer and oversized bodies without a send', () => fixture(async state => {
    const server = state.make().server();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = 'http://127.0.0.1:' + address.port + '/threads';
    try {
      assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify(publish),
        headers: { authorization: 'Bearer wrong' } })).status, 404);
      assert.deepEqual(state.calls, []);
      const ready = await fetch(url, { method: 'POST',
        body: JSON.stringify({ action: 'ready', target }),
        headers: { authorization: 'Bearer ' + token } });
      assert.equal(ready.status, 200);
      assert.deepEqual(await ready.json(), scope);
      const oversized = await fetch(url, { method: 'POST', body: 'x'.repeat(8193),
        headers: { authorization: 'Bearer ' + token } });
      assert.equal(oversized.status, 409);
      assert.deepEqual(await oversized.json(), { error: 'threads_relay_unconfirmed' });
      assert.equal(state.calls.filter(value => value === 'execute').length, 0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
