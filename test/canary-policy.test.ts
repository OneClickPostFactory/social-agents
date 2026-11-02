import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  allowedCanaryUserIds,
  canaryAllowsUser,
  rolloutBlockCode,
  runnableJobKinds,
  type RolloutPolicy,
} from '../src/canary-policy';

function policy(overrides: Partial<RolloutPolicy> = {}): RolloutPolicy {
  return {
    canaryRequired: true,
    canaryUserIds: new Set(),
    generationEnabled: false,
    providerDispatchEnabled: false,
    ...overrides,
  };
}

function main(): void {
  const blocked = policy();
  assert.deepEqual(allowedCanaryUserIds(blocked), []);
  assert.equal(canaryAllowsUser(blocked, 'tenant-a'), false);
  assert.equal(rolloutBlockCode(blocked, 'tenant-a', 'skip_slot'), 'rollout_canary_tenant_blocked');

  const allowlisted = policy({ canaryUserIds: new Set(['tenant-a']) });
  assert.equal(canaryAllowsUser(allowlisted, 'tenant-a'), true);
  assert.equal(canaryAllowsUser(allowlisted, 'tenant-b'), false);
  assert.deepEqual(runnableJobKinds(allowlisted), ['skip_slot', 'release_slot']);
  assert.equal(rolloutBlockCode(allowlisted, 'tenant-a', 'refresh_queue'), 'rollout_generation_disabled');
  assert.equal(rolloutBlockCode(allowlisted, 'tenant-a', 'publish_now'), 'rollout_provider_dispatch_disabled');
  assert.equal(rolloutBlockCode(allowlisted, 'tenant-a', 'skip_slot'), undefined);

  const generationOnly = policy({
    canaryUserIds: new Set(['tenant-a']),
    generationEnabled: true,
  });
  assert.deepEqual(runnableJobKinds(generationOnly), [
    'fetch_sources',
    'refresh_queue',
    'skip_slot',
    'release_slot',
  ]);
  assert.equal(rolloutBlockCode(generationOnly, 'tenant-a', 'refresh_queue'), undefined);
  assert.equal(rolloutBlockCode(generationOnly, 'tenant-a', 'publish_now'), 'rollout_provider_dispatch_disabled');

  const dispatchOnly = policy({
    canaryUserIds: new Set(['tenant-a']),
    providerDispatchEnabled: true,
  });
  assert.equal(rolloutBlockCode(dispatchOnly, 'tenant-a', 'publish_now'), undefined);
  assert.equal(rolloutBlockCode(dispatchOnly, 'tenant-a', 'refresh_queue'), 'rollout_generation_disabled');

  const unrestricted = policy({
    canaryRequired: false,
    canaryUserIds: new Set(),
    generationEnabled: true,
    providerDispatchEnabled: true,
  });
  assert.equal(allowedCanaryUserIds(unrestricted), undefined);
  assert.equal(canaryAllowsUser(unrestricted, 'any-tenant'), true);

  const root = path.resolve(__dirname, '../..');
  const wrangler = fs.readFileSync(path.join(root, 'wrangler.toml'), 'utf8');
  const productionConfig = wrangler.split('[env.collector_staging]')[0];
  assert.match(productionConfig, /SUPABASE_WORKER_BATCH_SIZE = "1"/);
  assert.match(productionConfig, /SUPABASE_WORKER_CANARY_REQUIRED = "true"/);
  assert.match(productionConfig, /SUPABASE_WORKER_GENERATION_ENABLED = "false"/);
  assert.match(productionConfig, /SUPABASE_PROVIDER_DISPATCH_ENABLED = "false"/);
  assert.match(productionConfig, /DAILY_INVENTORY_PLANNER_ENABLED = "false"/);
  assert.match(productionConfig, /REDDIT_CONNECTOR_ENABLED = "false"/);
  assert.match(productionConfig, /required = \["SUPABASE_WORKER_CANARY_USER_IDS"\]/);

  const workflow = fs.readFileSync(
    path.join(root, '.github/workflows/deploy-cloudflare-worker.yml'),
    'utf8'
  );
  assert.match(workflow, /SUPABASE_WORKER_CANARY_USER_IDS/);
  assert.match(workflow, /--secrets-file/);
  assert.match(workflow, /wrangler deploy --env=""/);
  assert.match(workflow, /Verify the exact fail-closed canary release/);
  assert.match(workflow, /oneclickpostfactory-agent\.woeinvests\.workers\.dev\/healthz/);
  assert.match(workflow, /body\.release\?\.gitSha !== expectedSha/);
  assert.match(workflow, /rollout\.providerDispatchEnabled !== false/);

  console.log('Canary rollout policy tests passed.');
}

main();

// Connector rollout is independent of generation and provider dispatch.
import { requireConnectorTenant } from '../src/reddit-connector';
const enabledConnector = { NODE_ENV: 'production', REDDIT_CONNECTOR_CANARY_USER_IDS: 'tenant-a' };
assert.doesNotThrow(() => requireConnectorTenant('tenant-a', enabledConnector));
assert.throws(() => requireConnectorTenant('tenant-b', enabledConnector), /not enabled for this account/);
assert.throws(() => requireConnectorTenant('tenant-a', { NODE_ENV: 'production' }), /not enabled for this account/);
