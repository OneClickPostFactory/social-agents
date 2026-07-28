import assert from 'node:assert/strict';
import test from 'node:test';

import * as instagram from '../src/instagram';
import * as threads from '../src/threads';
import { LegacyMetaPublicationDisabledError } from '../src/meta-publication-boundary';

test('retired Threads publisher fails before any provider operation', async () => {
  await assert.rejects(
    threads.publish('must never reach graph.threads.net'),
    (error: unknown) =>
      error instanceof LegacyMetaPublicationDisabledError
      && error.code === 'legacy_meta_publication_disabled'
      && error.platform === 'threads'
      && error.canonicalWorker.endsWith('/scripts/threads-outbox-runner.mjs'),
  );
});

test('retired Instagram publisher fails before render, upload, or provider operation', async () => {
  await assert.rejects(
    instagram.publish('must never publish', 'https://example.invalid/media.png'),
    (error: unknown) =>
      error instanceof LegacyMetaPublicationDisabledError
      && error.code === 'legacy_meta_publication_disabled'
      && error.platform === 'instagram'
      && error.canonicalWorker.endsWith('/scripts/instagram-publisher-outbox-runner.mjs'),
  );
});
