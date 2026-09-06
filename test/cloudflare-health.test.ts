import assert from 'node:assert/strict';

import worker from '../src/cloudflare-worker';

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

async function health(env: Record<string, unknown>): Promise<Record<string, any>> {
  const response = await worker.fetch(
    new Request('https://oneclickpostfactory.example/healthz'),
    env as any
  );
  assert.equal(response.status, 200);
  return response.json() as Promise<Record<string, any>>;
}

async function main(): Promise<void> {
  const gitSha = 'd5a98f46de5d8a9e1343685081231ca8f17da0a4';

  await test('health exposes liveness separately from release and provider readiness', async () => {
    const body = await health({
      CF_VERSION_METADATA: {
        id: 'worker-version-id',
        tag: gitSha,
        timestamp: '2026-09-06T08:00:00.000Z',
      },
    });

    assert.equal(body.ok, true);
    assert.equal(body.liveness, 'ok');
    assert.equal(body.readiness, 'not_evaluated');
    assert.equal(body.release.workerVersionId, 'worker-version-id');
    assert.equal(body.release.versionTag, gitSha);
    assert.equal(body.release.gitSha, gitSha);
    assert.equal(body.release.schemaContract, 'pre-publication-ledger-v1');
    assert.equal(body.release.appliedSchema, 'unverified');
  });

  await test('health does not advertise disabled or unverified publishers as ready', async () => {
    const body = await health({});
    const capabilities = body.publicationCapabilities;

    assert.deepEqual(capabilities.threads, {
      state: 'unavailable',
      code: 'legacy_meta_publication_disabled',
    });
    assert.deepEqual(capabilities.instagram, {
      state: 'unavailable',
      code: 'legacy_meta_publication_disabled',
    });
    assert.deepEqual(capabilities.facebook, {
      state: 'paused',
      code: 'facebook_publication_paused',
    });
    assert.equal(capabilities.linkedin.state, 'compatibility_unverified');
    assert.equal(capabilities.x.state, 'tenant_scoped');
  });

  await test('non-SHA Cloudflare version tags are not reported as canonical Git SHAs', async () => {
    const body = await health({
      CF_VERSION_METADATA: {
        id: 'worker-version-id',
        tag: 'manual-release',
        timestamp: '2026-09-06T08:00:00.000Z',
      },
    });

    assert.equal(body.release.versionTag, 'manual-release');
    assert.equal(body.release.gitSha, null);
  });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
