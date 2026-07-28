import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

async function main(): Promise<void> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'social-connector-test-'));
  process.env.APP_DATA_DIR = tempRoot;
  process.env.NODE_ENV = 'test';

  const config = (await import('../config')).default;
  const connector = await import('../src/social-connector');
  const { HttpError } = await import('../src/errors');
  const { handleSocialConnectorRequest } = await import('../src/social-connector-server');

  config.ENABLE_INSTAGRAM = true;
  config.ENABLE_FACEBOOK = true;
  config.ENABLE_THREADS = true;
  config.ENABLE_X = true;
  config.INSTAGRAM_ACCOUNT_ID = 'ig-test-account';
  config.FACEBOOK_PAGE_ACCESS_TOKEN = 'test-only-placeholder';
  config.FACEBOOK_GROUP_ID = 'fb-test-group';
  config.META_ACCESS_TOKEN = 'test-only-placeholder';
  config.THREADS_USER_ID = 'threads-test-user';
  config.THREADS_ACCESS_TOKEN = 'test-only-placeholder';
  config.X_OAUTH2_ACCESS_TOKEN = 'test-only-placeholder';

  test.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('status exposes truthful capabilities without credential material', async () => {
  const status = await connector.getSocialConnectorStatus();
  assert.equal(status.connector, 'social-agent');
  assert.equal(status.transport, 'unix-socket');
  assert.equal(status.accounts.length, 4);
  for (const account of status.accounts) {
    assert.deepEqual(account.capabilities, ['get_account', 'publish_post', 'verify_action']);
    assert.ok(account.unsupportedCapabilities.includes('reply_to_comment'));
    assert.equal(account.credentialStatus, 'available');
  }

  const serialized = JSON.stringify(status);
  assert.doesNotMatch(serialized, /test-only-placeholder/);
  assert.doesNotMatch(serialized, /access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization/i);
  });

  test('execution paths classify API, Relay, combined, and blocked truthfully', () => {
    assert.equal(connector.classifySocialExecutionPath({
      connectorAvailable: true,
      relayAvailable: false,
      operationSupported: true,
    }), 'api-ready');
    assert.equal(connector.classifySocialExecutionPath({
      connectorAvailable: false,
      relayAvailable: true,
      operationSupported: true,
    }), 'relay-only');
    assert.equal(connector.classifySocialExecutionPath({
      connectorAvailable: true,
      relayAvailable: true,
      operationSupported: true,
    }), 'api-and-relay');
    assert.equal(connector.classifySocialExecutionPath({
      connectorAvailable: false,
      relayAvailable: false,
      operationSupported: true,
    }), 'blocked');
    assert.equal(connector.classifySocialExecutionPath({
      connectorAvailable: true,
      relayAvailable: true,
      operationSupported: false,
    }), 'relay-only');
  });

  test('publish validation defaults to dry-run and performs no provider call', async () => {
  let called = false;
  const originalPublish = connector.__test__.adapters.threads.publish;
  connector.__test__.adapters.threads.publish = async () => {
    called = true;
    return 'should-not-run';
  };
  try {
    const result = await connector.executeSocialConnectorAction({
      liveSessionId: 'live-dry-run',
      platform: 'threads',
      accountKey: 'threads:threads-test-user',
      action: 'publish_post',
      targetId: 'account-feed',
      text: 'Dry-run connector validation',
    });
    assert.equal(result.outcome, 'validated');
    assert.equal(result.externalWritePerformed, false);
    assert.equal(called, false);
  } finally {
    connector.__test__.adapters.threads.publish = originalPublish;
  }
  });

  test('shared ledger blocks the same logical action across Relay and API paths', async () => {
  const text = 'One logical cross-path action';
  const fingerprint = crypto.createHash('sha256').update(text).digest('hex');
  const relay = connector.recordRelaySocialAction({
    phase: 'reserve',
    liveSessionId: 'live-shared-ledger',
    platform: 'threads',
    accountKey: 'threads:threads-test-user',
    actionType: 'publish_post',
    targetId: 'account-feed',
    contentFingerprint: fingerprint,
  });
  assert.equal(relay.outcome, 'reserved');
  assert.equal(relay.proceed, true);

  const api = await connector.executeSocialConnectorAction({
    liveSessionId: 'live-shared-ledger',
    platform: 'threads',
    accountKey: 'threads:threads-test-user',
    action: 'publish_post',
    targetId: 'account-feed',
    text,
    dryRun: false,
    explicitWriteApproval: true,
  });
  assert.equal(api.outcome, 'duplicate_blocked');
  assert.equal(api.externalWritePerformed, false);
  });

  test('ambiguous provider timeout is ledgered and requires verification before fallback', async () => {
  const originalPublish = connector.__test__.adapters.x.publish;
  connector.__test__.adapters.x.publish = async () => {
    throw new HttpError(502, 'Upstream request timed out', {
      code: 'UPSTREAM_TIMEOUT',
      expose: false,
    });
  };
  try {
    const result = await connector.executeSocialConnectorAction({
      liveSessionId: 'live-ambiguous',
      platform: 'x',
      accountKey: 'x:configured-user',
      action: 'publish_post',
      targetId: 'account-feed',
      text: 'Unique ambiguous action',
      dryRun: false,
      explicitWriteApproval: true,
    });
    assert.equal(result.outcome, 'ambiguous');
    assert.equal(result.externalWritePerformed, 'unknown');
    assert.match(String(result.nextAction), /Verify provider state/i);
  } finally {
    connector.__test__.adapters.x.publish = originalPublish;
  }
  });

  test('a published provider id stays ambiguous when read-back verification fails', async () => {
  const originalPublish = connector.__test__.adapters.facebook.publish;
  const originalVerify = connector.__test__.adapters.facebook.verifyPublished;
  connector.__test__.adapters.facebook.publish = async () => 'provider-post-id';
  connector.__test__.adapters.facebook.verifyPublished = async () => {
    throw new HttpError(403, 'Permission unavailable', {
      code: 'PERMISSION_FAILURE',
    });
  };
  try {
    const result = await connector.executeSocialConnectorAction({
      liveSessionId: 'live-verification-ambiguous',
      platform: 'facebook',
      accountKey: 'facebook:fb-test-group',
      action: 'publish_post',
      targetId: 'group-feed',
      text: 'Unique verification ambiguity',
      dryRun: false,
      explicitWriteApproval: true,
    });
    assert.equal(result.outcome, 'ambiguous');
    assert.equal(result.externalWritePerformed, true);
    assert.deepEqual(result.evidence, {
      providerResultId: 'provider-post-id',
      verified: false,
    });
  } finally {
    connector.__test__.adapters.facebook.publish = originalPublish;
    connector.__test__.adapters.facebook.verifyPublished = originalVerify;
  }
  });

  test('connector request facade rejects imaginary operations and keeps status non-sensitive', async () => {
  const unsupported = await handleSocialConnectorRequest({ operation: 'reply_to_comment' });
  assert.equal(unsupported.code, 'UNSUPPORTED_CONNECTOR_OPERATION');

  const status = await handleSocialConnectorRequest({ operation: 'status' });
  assert.equal(status.connector, 'social-agent');
  assert.doesNotMatch(JSON.stringify(status), /test-only-placeholder/);
  });
}

void main();
