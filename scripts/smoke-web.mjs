/**
 * Route smoke for dsh-dsweb.
 *
 * The old Playwright smoke drove the panel UI (`lib/client.js`), which was
 * deleted; after that the panel locators could never be found. This one mocks
 * nothing and needs no browser either: it speaks to the host routes directly
 * on a running `dsh web`.
 *
 *   dsh --profile web          # until it prints its loopback URL
 *   DSH_WEB_URL='http://127.0.0.1:18787/?token=…' pnpm smoke
 *
 * The plugin fence accepts Host=loopback and no Origin, which is exactly what a
 * server-side probe sends. A 403 usually means dsh web serves a non-loopback
 * Host — retry pointing DSH_WEB_URL at the loopback address.
 */

const raw = process.env.DSH_WEB_URL;
if (!raw) {
  console.error('set DSH_WEB_URL to the tokenized dsh web URL');
  process.exit(2);
}
let base;
try {
  base = new URL(raw);
} catch {
  console.error(`DSH_WEB_URL is not a URL: ${raw}`);
  process.exit(2);
}

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

/** One HTTP round trip; Origin stays absent, so the plugin's own fence applies.
 * The URL query (dsh web's `?token=…`) is passed through — dropping it is how a
 * probe would fail the host's browser-trust gate before ever reaching us. */
function hit(method, path) {
  return new Promise((resolve, reject) => {
    const request = fetch(`${base.origin}${path}${base.search}`, { method });
    request.then(async (response) => {
      resolve({ status: response.status, body: await response.text() });
    }, reject);
  });
}

const started = Date.now();

const state = await hit('GET', '/dsh-dsb/state');
if (state.status === 403) {
  console.error(`/dsh-dsb/state was fenced: ${state.body}`);
  console.error('run against the loopback address instead (Host must be 127.0.0.1)');
  process.exit(3);
} else {
  let payload = null;
  try {
    payload = JSON.parse(state.body);
  } catch {
    /* reported below */
  }
  check(
    '/dsh-dsb/state answers 200 with the vault state',
    state.status === 200 && payload !== null && typeof payload.hasToken === 'boolean',
    `status=${state.status} ${state.body.slice(0, 120)}`,
  );

  const methodGuard = await hit('POST', '/dsh-dsb/state');
  check('POST on /state is refused (a stale GET-only host is exposed by this)', methodGuard.status === 405, `got ${methodGuard.status}`);

  const login = await hit('GET', '/dsh-dsb/login/browser/status');
  let loginPayload = null;
  try {
    loginPayload = JSON.parse(login.body);
  } catch {
    /* reported below */
  }
  check(
    'the browser login route answers its session state',
    login.status === 200 && loginPayload !== null && loginPayload.login && typeof loginPayload.login.status === 'string',
    `status=${login.status} ${login.body.slice(0, 120)}`,
  );

  const sessions = await hit('GET', '/dsh-dsb/sessions');
  // Offline is fine while probing: run-node-tests replays the cursor walk, and
  // a probe without a token configured answers 401 authFailed.
  let sessionsParsed = null;
  try {
    sessionsParsed = JSON.parse(sessions.body);
  } catch {
    /* reported below */
  }
  const answered =
    (sessions.status === 200 && Array.isArray(sessionsParsed && sessionsParsed.sessions)) ||
    (sessions.status === 401 && sessionsParsed && sessionsParsed.authFailed === true);
  check(
    '/dsh-dsb/sessions answers a JSON list or a clean 401',
    answered,
    `status=${sessions.status} ${sessions.body.slice(0, 120)}`,
  );
}

console.log(failures === 0 ? `\nsmoke ok in ${Date.now() - started}ms` : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
