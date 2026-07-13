import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const workerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'supabase-worker.ts'), 'utf8');

test('scheduled recovery rows stop after an earlier same-platform recovery failure', () => {
  assert.match(workerSource, /async function loadPriorFailedRecovery\(row: QueueItemRow\)/);
  assert.match(workerSource, /if \(!row\.recovery_execution_id\) return undefined/);
  assert.match(workerSource, /column: 'platform', operator: 'eq', value: row\.platform/);
  assert.match(workerSource, /column: 'status', operator: 'eq', value: 'failed'/);
  assert.match(workerSource, /column: 'scheduled_for', operator: 'lte', value: row.scheduled_for/);
  assert.match(workerSource, /candidate => Boolean\(candidate\.recovery_execution_id\)/);
  assert.match(workerSource, /publish_recovery_paused_after_failure/);
  assert.match(workerSource, /status: 'skipped'/);
});

test('normal scheduled rows bypass recovery failure checks', () => {
  assert.match(workerSource, /if \(!row\.recovery_execution_id\) return undefined/);
});
