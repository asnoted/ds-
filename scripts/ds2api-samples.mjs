/**
 * Fetch the pinned ds2api capture the stream-replay suites use.
 *
 * The capture is AGPL-3.0 test data from CJackHwang/ds2api, so it is downloaded
 * into `.cache/` at test time instead of being committed here. The commit is
 * pinned; byte sizes catch a truncated download.
 */
import { mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMIT = 'cee8757d144e313149458909caee396b9f7f77ac';
const SAMPLE = 'continue-thinking-snapshot-replay-20260405';
const BASE = `https://api.github.com/repos/CJackHwang/ds2api/contents/tests/raw_stream_samples/${SAMPLE}`;
const FILES = {
  'meta.json': 11371,
  'upstream.stream.sse': 786382,
};

function cacheRoot() {
  if (process.env.DS2API_SAMPLES) return process.env.DS2API_SAMPLES;
  return fileURLToPath(new URL('../.cache/ds2api-samples', import.meta.url));
}

function sizeOf(path) {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

async function download(name, expected) {
  const headers = { accept: 'application/vnd.github.raw' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  let last;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/${name}?ref=${COMMIT}`, { headers });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length !== expected) throw new Error(`expected ${expected} bytes, got ${bytes.length}`);
      const target = join(cacheRoot(), SAMPLE, name);
      const temp = `${target}.tmp`;
      writeFileSync(temp, bytes);
      renameSync(temp, target);
      return;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw new Error(`could not fetch ds2api sample ${name}: ${last && last.message}`);
}

/** Absolute path to the cached sample directory, downloading it on first use. */
export async function ensureSample() {
  const dir = join(cacheRoot(), SAMPLE);
  mkdirSync(dir, { recursive: true });
  for (const [name, expected] of Object.entries(FILES)) {
    if (sizeOf(join(dir, name)) !== expected) await download(name, expected);
  }
  return dir;
}
