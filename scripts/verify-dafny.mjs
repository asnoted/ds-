/**
 * Differential runner for the Dafny twin of dsweb/lib/pow.js.
 *
 * `dafny build` verifies DeepSeekHashV1.dfy (structural contracts; that is
 * the part the verifier owns) and then compiles it, and this runner checks
 * the compiled jar against the JS source of truth: the official empty-string
 * vector pinned first (so a pow.js drift cannot hide), lengths alrededor of
 * the 136-byte rate, then mulberry32-seeded random inputs.
 *
 * The Java backend is the one that works in `.cache/`: C# compilation needs
 * a dotnet SDK and the JS backend output needs the npm module bignumber.js;
 * the JDK is already there and DafnyRuntime.jar ships inside the Dafny zip.
 *
 * Run: node scripts/verify-dafny.mjs
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { deepseekHashV1Hex } from '../dsweb/lib/pow.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cache = join(root, '.cache');
const dfy = join(root, 'verification', 'dafny', 'DeepSeekHashV1.dfy');
const name = join(cache, 'dafnyout', 'DeepSeekHashV1');
const JAR = `${name}.jar`;
const JDK = join(cache, 'jdk', 'Contents', 'Home');
const OFFICIAL_VECTOR = 'e594808bc5b7151ac160c6d39a02e0a8e261ed588578403099e3561dc40c26b3';
const DAFNY_VERSION = '4.11.0';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function bootstrapDafny() {
  console.log('verify-dafny: downloading Dafny…');
  const res = await fetch(`https://api.github.com/repos/dafny-lang/dafny/releases/tags/v${DAFNY_VERSION}`);
  const release = await res.json();
  const asset = (release.assets || []).find((a) =>
    /arm64/i.test(a.name) && /(osx|macos|mac)/i.test(a.name) && a.name.endsWith('.zip'));
  if (!asset) throw new Error(`verify-dafny: no macOS arm64 asset in v${DAFNY_VERSION}: ${(release.assets || []).map((a) => a.name).join(', ')}`);
  const zip = join(cache, 'dafny-dl.zip');
  const bin = Buffer.from(await (await fetch(asset.browser_download_url)).arrayBuffer());
  mkdirSync(cache, { recursive: true });
  writeFileSync(zip, bin);
  const stage = join(cache, 'dafny-stage');
  rmSync(stage, { recursive: true, force: true });
  execFileSync('unzip', ['-q', zip, '-d', stage]);
  rmSync(zip);
  const inner = readdirSync(stage).find((d) => existsSync(join(stage, d, 'dafny')));
  if (!inner) throw new Error(`verify-dafny: no dafny executable in ${asset.name}`);
  rmSync(join(cache, 'dafny'), { recursive: true, force: true });
  execFileSync('mv', [join(stage, inner), join(cache, 'dafny')]);
  rmSync(stage, { recursive: true, force: true });
}

const dafnyBin = join(cache, 'dafny', 'dafny', 'dafny');
if (!existsSync(dafnyBin)) await bootstrapDafny();
if (!existsSync(JAR)) {
  mkdirSync(join(cache, 'dafnyout'), { recursive: true });
  const env = { ...process.env, PATH: `${join(JDK, 'bin')}:${process.env.PATH}`, JAVA_HOME: JDK };
  try {
    const outText = execFileSync(dafnyBin, ['build', '-t', 'java', dfy, '-o', name], {
      env, cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26,
    });
    const tallied = /finished with (\d+) verified, (\d+) errors?/.exec(outText);
    if (tallied) console.log(`verify-dafny: build ok (${tallied[1]} verified, ${tallied[2]} errors)`);
  } catch (error) {
    const text = String(error.stderr || '') + String(error.stdout || '');
    console.error(text.trim().split('\n').slice(-15).join('\n'));
    process.exit(1);
  }
}

function runDafny(hexInput) {
  const outText = execFileSync(join(JDK, 'bin', 'java'), ['-jar', JAR, hexInput], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, maxBuffer: 1 << 20,
  });
  return outText.trim();
}

const initial = [new Uint8Array(0)];
for (const length of [1, 2, 7, 8, 9, 135, 136, 137, 271, 272, 273]) {
  initial.push(Uint8Array.from({ length }, (_, i) => (i * 37 + length) & 0xff));
}
const rng = mulberry32(0xC0FFEE);
while (initial.length < 60) {
  const length = 1 + Math.floor(rng() * 400);
  initial.push(Uint8Array.from({ length }, () => Math.floor(rng() * 256)));
}

const official = deepseekHashV1Hex(new Uint8Array(0));
if (official !== OFFICIAL_VECTOR) {
  console.error(`verify-dafny: pow.js itself lost the official vector: ${official}`);
  process.exit(1);
}

let failed = false;
for (const bytes of initial) {
  const expected = deepseekHashV1Hex(bytes);
  const actual = runDafny(Buffer.from(bytes).toString('hex'));
  const valid = /^[0-9a-f]{64}$/.test(actual);
  if (!valid || actual !== expected) {
    failed = true;
    console.error(`verify-dafny: MISMATCH len=${bytes.length}\n  js:     ${expected}\n  dafny:  ${actual}`);
    break;
  }
}
console.log(failed
  ? 'verify-dafny: FAILURES'
  : `verify-dafny: twin agrees with pow.js over ${initial.length} inputs (incl. official empty-string vector)`);
process.exit(failed ? 1 : 0);
