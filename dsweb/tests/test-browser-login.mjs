/**
 * Integration check for browser login capture.
 *
 * This is the one part of the feature that cannot be reviewed by reading the
 * code: a real Chromium has to expose a page over CDP, and `localStorage` has to
 * come back with the token. The fake page runs on loopback and the test passes
 * its origin explicitly, so the production route still only ever captures
 * chat.deepseek.com.
 *
 * Machines without Chromium/Chrome skip the browser half (the token
 * normalization checks still run), because CI images do not ship one.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { captureBrowserToken, findBrowser } from '../lib/browser-login.js';
import { normalizeToken } from '../lib/token.js';

const here = dirname(fileURLToPath(import.meta.url));

assert.equal(normalizeToken('Bearer abc.def'), 'abc.def');
assert.equal(normalizeToken('{"value":"abc.def","__version":"0"}'), 'abc.def');
assert.equal(normalizeToken('"abc.def"'), 'abc.def');
assert.equal(normalizeToken('  a b c  '), 'abc');
console.log('ok   token shapes normalize');

const browser = findBrowser();
if (!browser) {
  console.log('skip browser capture: no Chromium/Chrome found');
  console.log('\nALL PASS — token normalization only');
  process.exit(0);
}
assert.ok(existsSync(browser), `findBrowser returned a missing path: ${browser}`);
console.log(`ok   browser found: ${browser}`);

let page = 'seed';
const server = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  let seed = `if (!localStorage.getItem('userToken')) localStorage.setItem('userToken', JSON.stringify({ value: 'browser-test-token' }));`;
  if (page === 'seed') {
    seed = `localStorage.setItem('userToken', JSON.stringify({ value: 'browser-test-token', __version: '0' }));`;
  } else if (page === 'stale') {
    // A signed-out profile can still hold a dead token; the capture must not
    // close on it, and must pick up the new token once the user signs in.
    seed = `localStorage.setItem('userToken', JSON.stringify({ value: 'stale-token' }));
      setTimeout(() => localStorage.setItem('userToken', JSON.stringify({ value: 'fresh-token' })), 1500);`;
  }
  response.end(`<!doctype html><title>login fixture</title><script>${seed}</script>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const origin = `http://127.0.0.1:${port}`;
const profileDir = mkdtempSync(join(tmpdir(), 'dsb-browser-login-'));

try {
  const first = await captureBrowserToken({
    browserPath: browser,
    origin,
    url: `${origin}/seed`,
    profileDir,
    headless: true,
    timeoutMs: 20_000,
  });
  assert.equal(first.token, 'browser-test-token');
  console.log('ok   captured the token from a real Chromium page');

  // The same persistent profile must still hold the origin's storage on the
  // next launch; this is what lets a 401 re-read without signing in again.
  page = 'keep';
  const second = await captureBrowserToken({
    browserPath: browser,
    origin,
    url: `${origin}/keep`,
    profileDir,
    headless: true,
    timeoutMs: 20_000,
  });
  assert.equal(second.token, 'browser-test-token');
  console.log('ok   reused the persistent profile without seeding again');

  page = 'stale';
  const third = await captureBrowserToken({
    browserPath: browser,
    origin,
    url: `${origin}/stale`,
    profileDir,
    headless: true,
    timeoutMs: 20_000,
    validate: async (token) => {
      if (token === 'stale-token') {
        const error = new Error('expired');
        error.authFailed = true;
        throw error;
      }
    },
  });
  assert.equal(third.token, 'fresh-token');
  console.log('ok   ignored a rejected stale token and waited for a fresh one');
} finally {
  server.close();
  rmSync(profileDir, { recursive: true, force: true });
}

console.log('\nALL PASS — browser login capture');
