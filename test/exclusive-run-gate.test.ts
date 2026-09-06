import assert from 'node:assert/strict';

import { createExclusiveRunGate } from '../src/exclusive-run-gate';

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

async function main(): Promise<void> {
  await test('serializes deliberately interleaved async work', async () => {
    const gate = createExclusiveRunGate();
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;
    let releaseFirst!: () => void;
    let firstStarted!: () => void;

    const firstStartedPromise = new Promise<void>(resolve => {
      firstStarted = resolve;
    });
    const firstReleasePromise = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });

    const first = gate.run(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      events.push('tenant-a:start');
      firstStarted();
      await firstReleasePromise;
      events.push('tenant-a:end');
      active--;
      return 'tenant-a';
    });

    await firstStartedPromise;

    const second = gate.run(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      events.push('tenant-b:start');
      events.push('tenant-b:end');
      active--;
      return 'tenant-b';
    });

    await Promise.resolve();
    assert.deepEqual(gate.snapshot(), { active: 1, waiting: 1 });
    assert.deepEqual(events, ['tenant-a:start']);

    releaseFirst();
    assert.deepEqual(await Promise.all([first, second]), ['tenant-a', 'tenant-b']);
    assert.deepEqual(events, [
      'tenant-a:start',
      'tenant-a:end',
      'tenant-b:start',
      'tenant-b:end',
    ]);
    assert.equal(maxActive, 1);
    assert.deepEqual(gate.snapshot(), { active: 0, waiting: 0 });
  });

  await test('a failed run does not poison the next queued run', async () => {
    const gate = createExclusiveRunGate();

    await assert.rejects(
      gate.run(async () => {
        throw new Error('expected failure');
      }),
      /expected failure/
    );

    const result = await gate.run(async () => 'next-run-completed');
    assert.equal(result, 'next-run-completed');
    assert.deepEqual(gate.snapshot(), { active: 0, waiting: 0 });
  });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
