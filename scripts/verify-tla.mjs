/**
 * Model checker runner for the TLA+ specs in verification/tla.
 *
 * Bootstraps a JDK and tla2tools.jar into `.cache/` (gitignored) so nothing
 * needs to be installed. The five configs split in green (invariants that
 * must hold) and red (monitors expected to be violated; TLC's printed trace
 * is the documented finding — the run's stdout holds it when it finishes
 * with a violation, cleanup removes only the state database).
 *
 * tla2tools v1.7.4 runs fine on aarch64 as long as a module is standard-
 * shaped (a `---- MODULE name ----` header and a trailing `====` footer);
 * a bare `MODULE` head drives the parser into an error-recovery NPE — the
 * repro file in tlaplus#1392 is bare-headed too, which is what made it look
 * like an architecture bug. The x86_64 JVM fallback stays for cross-arch hosts.
 *
 * Run: node scripts/verify-tla.mjs
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cache = join(root, '.cache');
const tla = join(root, 'verification', 'tla');
const JAR = join(cache, 'tla2tools.jar');
const RUNNER = [
  { module: 'PaceGate', cfg: 'PaceGate-green.cfg', expect: 'green' },
  { module: 'PaceGate', cfg: 'PaceGate-slot.cfg', expect: 'red' },
  { module: 'SessionMap', cfg: 'SessionMap-fix.cfg', expect: 'green' },
  { module: 'SessionMap', cfg: 'SessionMap-bug.cfg', expect: 'red' },
  { module: 'SessionMap', cfg: 'SessionMap-dup.cfg', expect: 'red' },
];

function download(label, url, into) {
  console.log(`verify-tla: downloading ${label}…`);
  mkdirSync(into, { recursive: true });
  execFileSync('curl', ['--http1.1', '--retry', '3', '--retry-delay', '2', '-sS', '-L', '-o', join(cache, 'dl.tmp'), url], { cwd: root });
  execFileSync('tar', ['-xzf', join(cache, 'dl.tmp'), '-C', into, '--strip-components=1']);
  rmSync(join(cache, 'dl.tmp'));
}

function pickJava() {
  for (const dir of ['jdk', 'jdk-x64']) {
    const bin = join(cache, dir, 'Contents', 'Home', 'bin', 'java');
    if (existsSync(bin)) return bin;
  }
  return null;
}

let java = pickJava();
if (!java) {
  download('aarch64 Temurin 21 (native)', 'https://api.adoptium.net/v3/binary/latest/21/ga/mac/aarch64/jdk/hotspot/normal/eclipse?project=jdk', join(cache, 'jdk'));
  java = pickJava();
}
if (!existsSync(JAR)) download('tla2tools.jar', 'https://github.com/tlaplus/tlaplus/releases/latest/download/tla2tools.jar', cache);

let failed = false;
for (const item of RUNNER) {
  const args = ['-XX:+UseParallelGC', '-Xmx4g', '-cp', JAR, 'tlc2.TLC', '-config', item.cfg, item.module + '.tla'];
  let out = '';
  try {
    out = execFileSync(java, args, { cwd: tla, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 900_000, maxBuffer: 1 << 26 });
  } catch (error) {
    out = String(error.stdout || '') + String(error.stderr || '');
  }
  rmSync(join(tla, 'states'), { recursive: true, force: true });
  const broken = /NullPointerException|Fatal errors while parsing/.test(out);
  const violated = /\bis violated/.test(out);
  const complete = /No error has been found/.test(out);
  let ok;
  if (item.expect === 'green') ok = !broken && complete && !violated;
  else ok = !broken && violated;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${item.module} ${item.cfg} (${item.expect})`);
  if (!ok) {
    failed = true;
    const lines = out.split('\n').filter((l) => /Error|violated|Finished|Summary/.test(l));
    console.log(lines.slice(0, 5).join('\n'));
  } else if (item.expect === 'red') {
    const trace = /The behavior up to this point is:([\s\S]*?)<< /g.exec(out);
    if (trace) {
      console.log(`        trace states: ${trace[1].trim() ? trace[1].split('\n').length : '(none)'} lines captured in run output`);
    }
  }
}
console.log(failed ? 'verify-tla: FAILURES' : 'verify-tla: all five configs as expected');
process.exit(failed ? 1 : 0);
