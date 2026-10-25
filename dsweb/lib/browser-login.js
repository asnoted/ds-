/**
 * Browser login capture for chat.deepseek.com.
 *
 * The consumer web app keeps its credential in `localStorage.userToken` and has
 * no OAuth endpoint a third-party client can use. So `dsb` starts a Chromium
 * instance with its own persistent profile, lets the user sign in normally, and
 * reads the token over the Chrome DevTools Protocol. The profile is separate
 * from the user's daily browser; only this plugin's origin storage is touched.
 *
 * The token is still a web session credential and eventually expires. Keeping
 * the profile means a later capture can reuse a live session instead of asking
 * the user to sign in again; when the site itself has signed out, it cannot.
 *
 * @module dsh-dsb/browser-login
 */

import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

import { normalizeToken } from './token.js';
import { resolveStateDir } from './vault.js';

export const LOGIN_ORIGIN = 'https://chat.deepseek.com';

const PROFILE_DIR = 'browser-profile';
const LAUNCH_TIMEOUT_MS = 20_000;
const VISIBLE_TIMEOUT_MS = 10 * 60_000;
const HEADLESS_TIMEOUT_MS = 15_000;
const POLL_MS = 750;

const MAC_APPS = ['Chromium', 'Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Vivaldi'];
const LINUX_BROWSERS = [
  'chromium',
  'chromium-browser',
  'google-chrome',
  'google-chrome-stable',
  'microsoft-edge',
  'brave-browser',
];
const WINDOWS_BROWSERS = [
  ['Google', 'Chrome', 'Application', 'chrome.exe'],
  ['Chromium', 'Application', 'chrome.exe'],
  ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
  ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
];

function inPath(name) {
  const extensions = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const dir of String(process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = join(dir, `${name}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return '';
}

/** Absolute Chromium/Chrome path, or an empty string when none is installed. */
export function findBrowser() {
  const override = String(process.env.DSB_BROWSER_PATH || '').trim();
  if (override) {
    if (existsSync(override)) return override;
    return inPath(override);
  }

  const candidates = [];
  if (process.platform === 'darwin') {
    for (const app of MAC_APPS) {
      candidates.push(`/Applications/${app}.app/Contents/MacOS/${app}`);
      candidates.push(join(homedir(), 'Applications', `${app}.app`, 'Contents', 'MacOS', app));
    }
  } else if (process.platform === 'win32') {
    for (const root of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]) {
      if (!root) continue;
      for (const parts of WINDOWS_BROWSERS) candidates.push(join(root, ...parts));
    }
  } else {
    for (const name of LINUX_BROWSERS) {
      candidates.push(`/usr/bin/${name}`, `/usr/local/bin/${name}`);
    }
  }
  for (const name of LINUX_BROWSERS) {
    const found = inPath(name);
    if (found) candidates.push(found);
  }
  return candidates.find((candidate) => candidate && existsSync(candidate)) || '';
}

function resolveProfileDir() {
  return join(resolveStateDir(), PROFILE_DIR);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw codedError('aborted', '已取消浏览器登录');
}

function sameOrigin(candidate, origin) {
  try {
    return new URL(candidate).origin === origin;
  } catch {
    return false;
  }
}

function launchArgs({ profileDir, headless, url }) {
  const args = [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--new-window',
    url,
  ];
  if (headless) args.unshift('--headless=new');
  // Container/CI kernels deny the Chromium sandbox; opt in there, never by default.
  if (process.env.DSB_BROWSER_NO_SANDBOX) args.unshift('--no-sandbox', '--disable-gpu');
  return args;
}

async function waitForPort({ profileDir, child, signal, deadline }) {
  const portFile = join(profileDir, 'DevToolsActivePort');
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    if (child.exitCode !== null) throw codedError('closed', '浏览器已关闭');
    try {
      const port = Number(readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      /* not written yet */
    }
    await delay(100);
  }
  throw codedError('timeout', '浏览器没有启动调试端口');
}

async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) return [];
  const payload = await response.json();
  return Array.isArray(payload) ? payload : [];
}

async function waitForPage({ port, origin, url, signal, deadline }) {
  let opened = false;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    try {
      const targets = await listTargets(port);
      const target = targets.find(
        (item) => item.type === 'page' && item.webSocketDebuggerUrl && sameOrigin(item.url, origin),
      );
      if (target) return target;
    } catch {
      /* browser not listening yet */
    }
    if (!opened && Date.now() > deadline - LAUNCH_TIMEOUT_MS + 5_000) {
      opened = true;
      await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
        method: 'PUT',
        signal: AbortSignal.timeout(2_000),
      }).catch(() => {});
    }
    await delay(POLL_MS);
  }
  throw codedError('timeout', '浏览器没有打开登录页');
}

/** Small CDP client: one page target, one command at a time is enough here. */
function connectCdp(webSocketUrl) {
  return new Promise((resolve, reject) => {
    let socket;
    try {
      socket = new WebSocket(webSocketUrl);
    } catch (error) {
      reject(codedError('cdp', error.message));
      return;
    }
    let sequence = 0;
    const pending = new Map();
    const fail = (error) => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      pending.clear();
    };
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      reject(codedError('cdp', '连接浏览器调试端口超时'));
    }, 5_000);
    timer.unref();

    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve({
        send(method, params = {}) {
          return new Promise((resolveCommand, rejectCommand) => {
            const id = (sequence += 1);
            const commandTimer = setTimeout(() => {
              pending.delete(id);
              rejectCommand(codedError('cdp', '浏览器调试端口无响应'));
            }, 5_000);
            commandTimer.unref();
            pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer: commandTimer });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        close() {
          try {
            socket.close();
          } catch {
            /* already closed */
          }
        },
      });
    });

    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!message.id) return;
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(codedError('cdp', message.error.message || 'CDP error'));
      else entry.resolve(message.result);
    });

    socket.addEventListener('error', () => {
      clearTimeout(timer);
      fail(codedError('cdp', '无法连接浏览器调试端口'));
      reject(codedError('cdp', '无法连接浏览器调试端口'));
    });

    socket.addEventListener('close', () => {
      clearTimeout(timer);
      fail(codedError('cdp', '浏览器调试连接已关闭'));
    });
  });
}

const TOKEN_EXPRESSION = `(() => {
  try {
    const raw = localStorage.getItem('userToken');
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.value === 'string') return parsed.value;
    } catch {}
    return raw;
  } catch {
    return null;
  }
})()`;

async function readToken(cdp) {
  const reply = await cdp.send('Runtime.evaluate', {
    expression: TOKEN_EXPRESSION,
    returnByValue: true,
  });
  const value = reply && reply.result && reply.result.value;
  return normalizeToken(typeof value === 'string' ? value : '');
}

async function waitForToken({ cdp, origin, signal, deadline, validate }) {
  // A stale or guest token can sit in localStorage before the user signs in.
  // Validate it once, keep the window open on an auth rejection, and wait for
  // localStorage to change rather than closing on the first string we see.
  let checked = '';
  let forcedSignIn = false;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    try {
      const token = await readToken(cdp);
      if (token && token !== checked) {
        checked = token;
        if (!validate) return token;
        try {
          await validate(token);
          return token;
        } catch (error) {
          // Network trouble is not an auth verdict; let the route save it with
          // `valid: null` just like a manually pasted token.
          if (!(error && error.authFailed)) return token;
          // A dead token makes the app look signed in while every request
          // fails. Drop it and show the first-party sign-in page so the user
          // can actually re-authenticate in this window.
          if (!forcedSignIn && origin === LOGIN_ORIGIN) {
            forcedSignIn = true;
            await cdp
              .send('Runtime.evaluate', { expression: `localStorage.removeItem('userToken')` })
              .catch(() => {});
            await cdp.send('Page.navigate', { url: `${origin}/sign_in` }).catch(() => {});
          }
        }
      }
    } catch (error) {
      if (error && error.code === 'aborted') throw error;
    }
    await delay(POLL_MS);
  }
  return '';
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  const killer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }, 2_000);
  killer.unref();
  await Promise.race([exited, delay(3_000)]);
  clearTimeout(killer);
}

/**
 * Open the persistent profile, wait for a token, then close the browser.
 *
 * `origin`/`url` are only overridden by the integration test; the routes always
 * use chat.deepseek.com. `signal` lets the route cancel a login the user gave up
 * on without leaving a stray browser running.
 */
export async function captureBrowserToken(options = {}) {
  const browser = options.browserPath || findBrowser();
  if (!browser) throw codedError('no-browser', '没有找到 Chromium / Chrome');
  const origin = options.origin || LOGIN_ORIGIN;
  const url = options.url || `${origin}/`;
  const headless = Boolean(options.headless);
  const profileDir = options.profileDir || resolveProfileDir();
  const signal = options.signal;
  const validate = options.validate;
  const timeoutMs = options.timeoutMs ?? (headless ? HEADLESS_TIMEOUT_MS : VISIBLE_TIMEOUT_MS);

  throwIfAborted(signal);
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(profileDir, 0o700);
  } catch {
    /* best effort on filesystems without POSIX modes */
  }
  const portFile = join(profileDir, 'DevToolsActivePort');
  rmSync(portFile, { force: true });

  const child = spawn(browser, launchArgs({ profileDir, headless, url }), { stdio: 'ignore' });
  // Cancel should close the window immediately, not after the poll timer wakes.
  const onAbort = () => {
    stopChild(child).catch(() => {});
  };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  const exited = new Promise((_, reject) => {
    child.once('error', (error) => reject(codedError('closed', error.message)));
    child.once('exit', (code) => reject(codedError('closed', `浏览器已关闭（${code ?? 'unknown'}）`)));
  });
  exited.catch(() => {});

  let cdp = null;
  try {
    const port = await Promise.race([
      waitForPort({ profileDir, child, signal, deadline: Date.now() + LAUNCH_TIMEOUT_MS }),
      exited,
    ]);
    const target = await Promise.race([
      waitForPage({ port, origin, url, signal, deadline: Date.now() + LAUNCH_TIMEOUT_MS }),
      exited,
    ]);
    cdp = await connectCdp(target.webSocketDebuggerUrl);
    const token = await Promise.race([
      waitForToken({ cdp, origin, signal, validate, deadline: Date.now() + timeoutMs }),
      exited,
    ]);
    if (!token) throw codedError('timeout', '没有读到 chat.deepseek.com 登录态');
    return { token, browser };
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    if (cdp) cdp.close();
    await stopChild(child);
  }
}

/* ------------------------------------------------------------------ *
 * Route-facing session state
 * ------------------------------------------------------------------ */

const IDLE = { status: 'idle', headless: false, error: '', code: '', browser: '' };

let current = { ...IDLE };
let captured = '';
let controller = null;

export function browserLoginStatus() {
  return { ...current };
}

export function startBrowserLogin({ headless = false, validate } = {}) {
  if (current.status === 'waiting' || current.status === 'captured') return browserLoginStatus();
  if (controller) {
    controller.abort();
    controller = null;
  }
  captured = '';

  const browser = findBrowser();
  if (!browser) {
    current = {
      status: 'error',
      headless,
      error: '没有找到 Chromium / Chrome',
      code: 'no-browser',
      browser: '',
    };
    return browserLoginStatus();
  }

  const local = new AbortController();
  controller = local;
  current = { status: 'waiting', headless, error: '', code: '', browser };
  captureBrowserToken({ headless, browserPath: browser, signal: local.signal, validate })
    .then(({ token }) => {
      if (controller !== local) return;
      captured = token;
      current = { status: 'captured', headless, error: '', code: '', browser };
    })
    .catch((error) => {
      if (controller !== local || (error && error.code === 'aborted')) return;
      current = {
        status: error && error.code === 'timeout' ? 'timeout' : 'error',
        headless,
        error: error instanceof Error ? error.message : String(error),
        code: (error && error.code) || '',
        browser,
      };
    })
    .finally(() => {
      if (controller === local) controller = null;
    });
  return browserLoginStatus();
}

export function takeBrowserToken() {
  return captured;
}

export function completeBrowserLogin() {
  captured = '';
  current = { ...current, status: 'saved', error: '', code: '' };
}

export function failBrowserLogin(error = '浏览器登录没有通过验证') {
  captured = '';
  current = { ...current, status: 'error', error, code: 'auth-failed' };
}

export function cancelBrowserLogin() {
  if (controller) {
    controller.abort();
    controller = null;
  }
  captured = '';
  current = { ...IDLE };
}
