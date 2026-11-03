import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { publishThreadsCloud } from '../src/threads-cloud-publisher';
const input = { accountId: '123', accessToken: 'test-token', text: 'approved text' };
test('cloud publishing verifies account, creates container, publishes and reads back', async () => {
  const calls: string[] = [];
  const send = async (url: string) => {
    calls.push(url);
    const id = calls.length === 1 ? '123' : calls.length === 2 ? '456' : '789';
    return new Response(JSON.stringify({ id }), { status: 200 });
  };
  assert.equal(await publishThreadsCloud(input, send), '789');
  assert.equal(calls.length, 4);
});
test('wrong account never creates container', async () => {
  let calls = 0;
  await assert.rejects(publishThreadsCloud(input, async () => { calls++; return new Response('{"id":"999"}'); }), /account_mismatch/);
  assert.equal(calls, 1);
});
test('missing credentials do not call provider', async () => {
  await assert.rejects(publishThreadsCloud({ ...input, accessToken: '' }, async () => { throw Error('unexpected call'); }), /input_invalid/);
});
test('lost publication response stays unconfirmed, never retries', async () => {
  let calls = 0;
  await assert.rejects(publishThreadsCloud(input, async () => {
    calls++;
    if (calls === 3) throw Error('connection_lost');
    return new Response(JSON.stringify({ id: calls === 1 ? '123' : '456' }));
  }), /connection_lost/);
  assert.equal(calls, 3);
});
