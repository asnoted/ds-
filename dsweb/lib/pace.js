/**
 * The one outbound pace for automated web turns.
 *
 * The legacy gate drew a 3–15 s Beta(2,4) interval (mode 6 s) from the moment a
 * message was actually sent. The agent loop sends turns back to back, so the new
 * channel has to keep the same spacing; a single in-flight lock is not a rate
 * limit. The first turn is immediate, every later one waits out the interval
 * drawn after the previous send.
 *
 * @module dsh-dsb/pace
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const MIN_MS = 3_000;
export const MAX_MS = 15_000;
const SAMPLE_SIZE = 5;
const SAMPLE_RANK = 2;
const VERSION = 1;

/** The last send time survives a restart: a fresh DSH process still owes the interval. */
function defaultFile() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-dsb', 'pace.json');
}

function load(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && parsed.version === VERSION
      && Number.isFinite(parsed.lastSentAt) && Number.isFinite(parsed.intervalMs)) {
      return { lastSentAt: parsed.lastSentAt, intervalMs: parsed.intervalMs };
    }
  } catch {
    /* no state yet */
  }
  return null;
}

/** Beta(2,4): the second-smallest of five uniforms, mapped to [3 s, 15 s]. */
export function drawInterval(random = Math.random) {
  const draws = [];
  for (let index = 0; index < SAMPLE_SIZE; index += 1) {
    const raw = random();
    draws.push(Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 1) : 0);
  }
  draws.sort((left, right) => left - right);
  return Math.round(MIN_MS + draws[SAMPLE_RANK - 1] * (MAX_MS - MIN_MS));
}

function abortError() {
  return Object.assign(new Error('已停止生成'), { code: 'ABORTED' });
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * `wait()` is the gate: call it immediately before a send. It returns after the
 * interval since the previous send and records this one; aborting the wait
 * rejects without recording, so a cancelled turn does not consume the slot.
 *
 * `now`, `random`, and `sleep` are injectable so the clock and the drawn
 * interval can be asserted without real waiting.
 */
export function createPacer({
  file = defaultFile(),
  now = Date.now,
  random = Math.random,
  sleep: sleeper = sleep,
} = {}) {
  let state = load(file) ?? { lastSentAt: null, intervalMs: 0 };

  const waitMs = () => {
    if (state.lastSentAt === null) return 0;
    const waited = now() - state.lastSentAt;
    if (waited < 0 || waited >= state.intervalMs) return 0;
    return state.intervalMs - waited;
  };

  /** Take a later send another process persisted, so two DSH processes share the gate. */
  const refresh = () => {
    const disk = load(file);
    if (disk && (state.lastSentAt === null || disk.lastSentAt > state.lastSentAt)) state = disk;
  };

  const note = () => {
    state = { lastSentAt: now(), intervalMs: drawInterval(random) };
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: VERSION, ...state }), { mode: 0o600 });
    renameSync(temporary, file);
    try {
      chmodSync(file, 0o600);
    } catch {
      /* best effort on filesystems without POSIX modes */
    }
  };

  return {
    waitMs,
    async wait(signal) {
      for (;;) {
        refresh();
        const remaining = waitMs();
        if (remaining <= 0) break;
        await sleeper(remaining, signal);
        if (signal?.aborted) throw abortError();
      }
      note();
    },
  };
}
