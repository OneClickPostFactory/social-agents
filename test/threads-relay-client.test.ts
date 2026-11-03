import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectThreadsRelay, recoverThreadsRelayReceipt, type ThreadsRelayAttempt } from '../src/threads-relay-client';
import type { ControlledPublish } from '../src/controlled-publish';

const target = (): ControlledPublish => ({
  jobId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
  queueId: '00000000-0000-4000-8000-000000000003',
  accountId: '123456', platform: 'threads', generation: 1,
  approvalHash: 'a'.repeat(64), expiresAt: Date.now() + 60000,
});
const attempt: ThreadsRelayAttempt = {
  attemptId: '00000000-0000-4000-8000-000000000004',
  dispatchOperationId: '00000000-0000-4000-8000-000000000005',
};
const endpoint = 'https://relay.example.test/threads';
const bearer = 'test-only-'.padEnd(64, '0');

test('relay client binds exact attempt and recovers only through read-only receipts', async t => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  try {
    await t.test('checks readiness and sends the same frozen attempt once under concurrency', async () => {
      const scope = target();
      const original = { ...scope };
      const actions: string[] = [];
      globalThis.fetch = async (url, init) => {
        assert.equal(String(url), endpoint);
        assert.equal(init?.redirect, 'manual');
        assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer ' + bearer);
        const body = JSON.parse(String(init?.body));
        actions.push(body.action);
        assert.deepEqual(body.target, original);
        if (body.action === 'ready') return Response.json(original);
        assert.deepEqual(body.attempt, attempt);
        assert.equal(body.text, 'Approved text');
        return Response.json({ ...original, ...attempt, externalPostId: '987654' });
      };
      const send = await connectThreadsRelay(scope, endpoint, bearer);
      scope.accountId = '999999'; // caller mutation cannot change the captured destination
      assert.deepEqual(await Promise.all([send('Approved text', attempt), send('Approved text', { ...attempt })]),
        ['987654', '987654']);
      await assert.rejects(send('Different text', attempt), /operation_mismatch/);
      assert.deepEqual(actions, ['ready', 'publish']);
    });

    await t.test('lost publication response retrieves the exact cached receipt without resend', async () => {
      const scope = target();
      const actions: string[] = [];
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        actions.push(body.action);
        if (body.action === 'ready') return Response.json(scope);
        assert.deepEqual(body.attempt, attempt);
        if (body.action === 'publish') throw new TypeError('response lost after provider acceptance');
        assert.equal(body.text, undefined);
        return Response.json({ ...scope, ...attempt, externalPostId: '987654' });
      };
      const send = await connectThreadsRelay(scope, endpoint, bearer);
      assert.equal(await send('Approved text', attempt), '987654');
      assert.equal(await send('Approved text', attempt), '987654');
      assert.deepEqual(actions, ['ready', 'publish', 'receipt']);
    });

    await t.test('unknown dispatch stays unknown across repeated caller requests', async () => {
      const scope = target();
      const actions: string[] = [];
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        actions.push(body.action);
        return body.action === 'ready' ? Response.json(scope) : new Response('', { status: 409 });
      };
      const send = await connectThreadsRelay(scope, endpoint, bearer);
      await assert.rejects(send('Approved text', attempt), /publication_unconfirmed/);
      await assert.rejects(send('Approved text', attempt), /publication_unconfirmed/);
      assert.deepEqual(actions, ['ready', 'publish', 'receipt']);
    });

    await t.test('a mismatched receipt never confirms another attempt or approval', async () => {
      const scope = target();
      const actions: string[] = [];
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        actions.push(body.action);
        if (body.action === 'ready') return Response.json(scope);
        return Response.json({ ...scope, ...attempt, approvalHash: 'b'.repeat(64), externalPostId: '987654' });
      };
      const send = await connectThreadsRelay(scope, endpoint, bearer);
      await assert.rejects(send('Approved text', attempt), /publication_unconfirmed/);
      assert.deepEqual(actions, ['ready', 'publish', 'receipt']);
    });

    await t.test('a response for another dispatch operation is rejected', async () => {
      const scope = target();
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        return Response.json(body.action === 'ready' ? scope :
          { ...scope, ...attempt, dispatchOperationId: '00000000-0000-4000-8000-000000000099', externalPostId: '987654' });
      };
      const send = await connectThreadsRelay(scope, endpoint, bearer);
      await assert.rejects(send('Approved text', attempt), /publication_unconfirmed/);
    });

    await t.test('preflight mismatch leaves the job unclaimed and sends no content', async () => {
      const scope = target();
      const actions: string[] = [];
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        actions.push(body.action);
        assert.equal(body.text, undefined);
        return Response.json({ ...scope, accountId: '999999' });
      };
      await assert.rejects(connectThreadsRelay(scope, endpoint, bearer), /scope_mismatch/);
      assert.deepEqual(actions, ['ready']);
    });

    await t.test('expired send window prevents publication after a successful preflight', async () => {
      const scope = target();
      const actions: string[] = [];
      globalThis.fetch = async (_url, init) => {
        actions.push(JSON.parse(String(init?.body)).action);
        return Response.json(scope);
      };
      const send = await connectThreadsRelay(scope, endpoint, bearer);
      Date.now = () => scope.expiresAt;
      try { await assert.rejects(send('Approved text', attempt), /controlled_publish_expired/); }
      finally { Date.now = originalNow; }
      assert.deepEqual(actions, ['ready']);
    });

    await t.test('receipt recovery still works when the grant expires after dispatch', async () => {
      const scope = target();
      const actions: string[] = [];
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        actions.push(body.action);
        if (body.action === 'ready') return Response.json(scope);
        if (body.action === 'publish') {
          Date.now = () => scope.expiresAt;
          throw Error('response lost at expiry');
        }
        return Response.json({ ...scope, ...attempt, externalPostId: '987654' });
      };
      try {
        const send = await connectThreadsRelay(scope, endpoint, bearer);
        assert.equal(await send('Approved text', attempt), '987654');
      } finally { Date.now = originalNow; }
      assert.deepEqual(actions, ['ready', 'publish', 'receipt']);
    });

    await t.test('restart recovery reads a receipt directly after authority expires', async () => {
      const scope = { ...target(), expiresAt: Date.now() - 1000 };
      const actions: string[] = [];
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        actions.push(body.action);
        assert.equal(body.text, undefined);
        assert.deepEqual(body.attempt, attempt);
        return Response.json({ ...scope, ...attempt, externalPostId: '987654' });
      };
      assert.equal(await recoverThreadsRelayReceipt(scope, endpoint, bearer, attempt), '987654');
      assert.deepEqual(actions, ['receipt']);
    });

    await t.test('missing attempt and unsafe endpoint never reach publication', async () => {
      const scope = target();
      let calls = 0;
      globalThis.fetch = async () => { calls++; return Response.json(scope); };
      await assert.rejects(connectThreadsRelay(scope, 'http://relay.example.test/threads', bearer), /invalid_threads_relay/);
      await assert.rejects(connectThreadsRelay(scope, endpoint + '?redirect=bad', bearer), /invalid_threads_relay/);
      assert.equal(calls, 0);
      const send = await connectThreadsRelay(scope, endpoint, bearer);
      assert.throws(() => send('Approved text', { attemptId: '', dispatchOperationId: '' }), /attempt_invalid/);
      assert.equal(calls, 1);
    });
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; }
});
