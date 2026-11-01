/**
 * The outbound pace: Beta(2,4) over 3–15 s, drawn after each send and persisted.
 *
 * The important part is not the distribution but the accounting: the first turn
 * is immediate, the wait is measured from the previous send, an aborted wait
 * must not record a send, and a new pacer (a restarted DSH process) must still
 * owe the interval.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MAX_MS, MIN_MS, createPacer, drawInterval } from '../lib/pace.js';

const dir = mkdtempSync(join(tmpdir(), 'dsb-pace-'));
let ser = 0;
const file = () => join(dir, `pace-${(ser += 1)}.json`);

try {
  assert.equal(drawInterval(() => 0), MIN_MS);
  assert.equal(drawInterval(() => 1), MAX_MS);
  assert.equal(drawInterval(() => 0.25), 6_000, 'the Beta(2,4) mode is 6 s');

  {
    let now = 0;
    const sleeps = [];
    const pacer = createPacer({
      file: file(),
      now: () => now,
      random: () => 0.25,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });

    await pacer.wait();
    assert.deepEqual(sleeps, [], 'the first turn is immediate');

    now += 1_000;
    await pacer.wait();
    assert.deepEqual(sleeps, [5_000], 'the wait is the remainder of the previous interval');

    now += 6_000;
    await pacer.wait();
    assert.deepEqual(sleeps, [5_000], 'an elapsed interval does not wait again');
  }

  {
    let now = 0;
    const pacer = createPacer({
      file: file(),
      now: () => now,
      random: () => 0,
      sleep: (ms, signal) => new Promise((resolve, reject) => {
        const onAbort = () => reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }));
        if (signal?.aborted) return onAbort();
        signal?.addEventListener('abort', onAbort, { once: true });
      }),
    });
    await pacer.wait();
    now += 1_000;
    const controller = new AbortController();
    const pending = pacer.wait(controller.signal);
    controller.abort();
    await assert.rejects(pending, /aborted/);
    assert.equal(pacer.waitMs(), 2_000, 'an aborted wait does not record the send');
  }

  {
    const shared = file();
    let now = 0;
    const sleeps = [];
    const first = createPacer({
      file: shared,
      now: () => now,
      random: () => 0.25,
      sleep: async (ms) => { sleeps.push(ms); now += ms; },
    });
    await first.wait();

    // A restarted process constructs a fresh pacer; it must read the saved send.
    now = 1_000;
    const restarted = createPacer({
      file: shared,
      now: () => now,
      random: () => 0.25,
      sleep: async (ms) => { sleeps.push(ms); now += ms; },
    });
    await restarted.wait();
    assert.deepEqual(sleeps, [5_000], 'a new process still owes the interval');
  }

  console.log('pace: all passing');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
