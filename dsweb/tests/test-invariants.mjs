/**
 * Property-based invariants over the exported pure functions.
 *
 * Every fuzz corpus is driven by one seeded PRNG (SEED below), so a red run
 * replays the exact same cases. These are invariants, not fixtures: no input —
 * including structured junk — is allowed to break the contracts (never throw,
 * bounded output, faithful round-trip). The target is always the real
 * implementation, never a copy.
 *
 * Run: node test-invariants.mjs
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeToken } from '../lib/token.js';
import { decodeTitle, reduceChunk } from '../lib/deepseek.js';
import { drawInterval, MAX_MS, MIN_MS } from '../lib/pace.js';
import { deepseekHashV1, deepseekHashV1Hex } from '../lib/pow.js';
import { createSessionMap } from '../lib/session-map.js';
import { parseArgs, parseAnswer } from '../lib/web-model.js';

const SEED = 20260405;

// mulberry32: stable across runs and Node versions, so a red run names a seed
// that reproduces it exactly.
function mulberry32(seed) {
  return function random() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(SEED);
const int = (bound) => Math.floor(random() * bound);
const pick = (list) => list[int(list.length)];
/** Unbounded junk: operators, JSON gadgets, control chars, CJK, one lone surrogate. */
const JUNK_CHARS = ' \'"{},:[]\\n\\r\t=0aBZx/-%#*_~?!.「对%'.split('');
JUNK_CHARS.push(String.fromCharCode(0xd800), String.fromCharCode(0xdc00));

function junkString(max) {
  let value = '';
  const length = int(max);
  for (let i = 0; i < length; i += 1) value += pick(JUNK_CHARS);
  return value;
}

let failures = 0;
function check(label, condition) {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
}

// -- token: idempotence over everything a user or the browser can hand over ---
{
  const prefixes = ['', 'Bearer ', 'bearer    ', '"', '{'];
  const wrappers = ['', '', '"', "'", ' '];
  let ok = true;
  for (let i = 0; i < 400; i += 1) {
    const raw = pick(wrappers) + pick(prefixes) + junkString(30) + pick(wrappers);
    const once = normalizeToken(raw);
    if (typeof once !== 'string' || normalizeToken(once) !== once) {
      ok = false;
      console.log(`      token case ${i}: ${JSON.stringify(raw)} -> ${JSON.stringify(once)}`);
    }
  }
  ok = ok && [undefined, null, 42, {}, []].every((raw) => normalizeToken(raw) === '');
  // A DevTools copy of the whole localStorage value arrives as a quoted
  // envelope ("{"value":"x"}"); two strip passes are needed. Pinned through a
  // replace() so the escaping cannot lie about what the real string contains.
  ok = ok && normalizeToken('"{<q>value<q>:<q>x<q>}"'.replace(/<q>/g, '"')) === 'x';
  check('token: normalizeToken is idempotent and never fabricates a non-string', ok);
}

// -- title: percent round-trip, and raw text fallback never throws ------------
{
  // Split by code point: the emoji is a surrogate PAIR, and a lone half would
  // make encodeURIComponent throw on the generator, not on the code under test.
  const ALPHABET = [...'abcXYZ 09%「对」话测试€😀\n\t'];

  const randomTitle = () => Array.from({ length: int(40) }, () => pick(ALPHABET)).join('');
  const titles = Array.from({ length: 400 }, randomTitle);
  titles.push('');

  let ok = true;
  for (const title of titles) {
    // encodeURIComponent escapes everything decodeURIComponent expects; the
    // pair is the exact upstream encoding the site applies to titles.
    ok = ok && decodeTitle(encodeURIComponent(title)) === title;
  }
  const junk = ['%', '%E5%AF%B9', '%%', `a${String.fromCharCode(0xd800)}b`, '%zz', undefined, null, 42, {}, '###'];
  ok = ok && junk.every((raw) => {
    const first = decodeTitle(raw);
    return typeof first === 'string' && decodeTitle(raw) === first;
  });
  check('title: decodeTitle survives junk with a raw fallback and round-trips real titles', ok);
}

// -- pace: the drawn interval always lands inside the advertised window -------
{
  let ok = true;
  for (let i = 0; i < 300; i += 1) {
    const interval = drawInterval(mulberry32(SEED + i));
    ok = ok && Number.isInteger(interval) && interval >= MIN_MS && interval <= MAX_MS;
  }
  // A broken or hostile random source must still clamp, not escape.
  const junks = [NaN, Infinity, -Infinity, 0, 1, 2, -5, 1e300, () => 0.5];
  ok = ok && junks.every((junk) => {
    const interval = drawInterval(() => (typeof junk === 'function' ? junk() : junk));
    return Number.isInteger(interval) && interval >= MIN_MS && interval <= MAX_MS;
  });
  ok = ok
    && drawInterval(mulberry32(SEED)) === drawInterval(mulberry32(SEED))
    && drawInterval(mulberry32(SEED)) !== drawInterval(mulberry32(SEED + 1));
  check('pace: drawInterval stays an integer inside [MIN_MS, MAX_MS] and replays deterministically', ok);
}

// -- session map: bind/commit/pending round-trip incl. persistence and faults -
{
  const directory = mkdtempSync(join(tmpdir(), 'dsh-dsb-invariants-'));
  const makeLog = () => Array.from({ length: 1 + int(8) }, () => `msg-${junkString(10)}`);
  let ok = true;

  try {
    const file = join(directory, 'web-sessions.json');
    const map = createSessionMap({ file });
    const key = 'dsh-1';
    ok = ok
      && map.webSessionFor(key) === ''
      && map.pending(key, [], 'v1').rebuild === true
      && map.pending(key, [], 'v1').cursor === 0;

    const log = makeLog();
    map.bind(key, 'web-1', 'v1');
    ok = ok
      && map.webSessionFor(key) === 'web-1'
      && map.parentFor(key) === 0
      && (() => {
        const pending = map.pending(key, log, 'v1');
        return pending.rebuild === false
          && JSON.stringify(pending.fresh) === JSON.stringify(log)
          && pending.cursor === 0;
      })();

    map.commit(key, log, 'v1');
    const longer = [...log, 'new'];
    ok = ok
      && (() => {
        const pending = map.pending(key, longer, 'v1');
        return pending.rebuild === false
          && JSON.stringify(pending.fresh) === '["new"]'
          && pending.cursor === log.length;
      })()
      // A log that SHRANK below the committed cursor cannot be a delta: rebuild.
      && map.pending(key, log.slice(1), 'v1').rebuild === true;

    // Crash between turn and write: a fresh instance replays the same file.
    const reloaded = createSessionMap({ file });
    ok = ok
      && reloaded.webSessionFor(key) === 'web-1'
      && reloaded.pending(key, longer, 'v1').rebuild === false;

    // A rewritten history (compaction, edit) must force a full rebuild.
    const tampered = JSON.parse(readFileSync(file, 'utf8'));
    tampered.sessions[key].digest = 'deadbeef';
    writeFileSync(file, JSON.stringify(tampered));
    ok = ok && createSessionMap({ file }).pending(key, longer, 'v1').rebuild === true;

    // A prompt built under a different catalog version must rebuild.
    map.bind('dsh-2', 'web-2', 'v1');
    ok = ok
      && map.pending('dsh-2', log, 'v1').rebuild === false
      && map.pending('dsh-2', log, 'v2').rebuild === true;

    map.bind('dsh-3', 'web-3', 'v1');
    map.setParent('dsh-3', 7);
    ok = ok
      && map.parentFor('dsh-3') === 7
      && map.setParent('dsh-3', 0) === false && map.parentFor('dsh-3') === 7
      && map.setParent('dsh-3', -1) === false && map.parentFor('dsh-3') === 7;

    map.forget('dsh-2');
    ok = ok
      && map.webSessionFor('dsh-2') === ''
      && map.pending('dsh-2', log, 'v1').rebuild === true;

    // The map file stays bounded: 105 binds leave at most 99 entries, with the
    // last-bound one among the survivors.
    const bounded = createSessionMap({ file: join(directory, 'bounded.json') });
    for (let i = 0; i < 105; i += 1) bounded.bind(`dsh-${i}`, `web-${i}`, undefined);
    const stored = JSON.parse(readFileSync(join(directory, 'bounded.json'), 'utf8')).sessions;
    ok = ok && Object.keys(stored).length <= 99 && typeof stored['dsh-104'].webSessionId === 'string';
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  check('session map: round-trip, crash-resume, tamper/protocol/shrink rebuilds, bounded file', ok);
}

// -- pow: same bytes, same digest; digests are 32 bytes; hex and bytes agree ---
{
  let ok = true;
  ok = ok && deepseekHashV1Hex(new TextEncoder().encode('')) === 'e594808bc5b7151ac160c6d39a02e0a8e261ed588578403099e3561dc40c26b3';
  for (let i = 0; i < 300; i += 1) {
    const bytes = new Uint8Array(int(64));
    for (let j = 0; j < bytes.length; j += 1) bytes[j] = int(256);
    const first = deepseekHashV1(bytes);
    const second = deepseekHashV1(bytes);
    ok = ok
      && Buffer.compare(Buffer.from(first), Buffer.from(second)) === 0
      && first.length === 32
      && deepseekHashV1Hex(bytes) === Buffer.from(first).toString('hex');
  }
  check('pow: DeepSeekHashV1 is deterministic, 32 bytes, and agrees with its hex form', ok);
}

// -- chunks: structured junk never breaks the reducer's shape contract --------
{
  const JUNK_VALUE = [null, undefined, 0, -1, NaN, Infinity, '', ' ', 'x', true, false, 3.14, [], {}, [1, 'a'], new Map(), new Set(), new Date(), /re/];
  const PATHS = ['', 'response/content', 'response/thinking_content', 'response/fragments', 'response/fragments/-1/content', 'response/search_status', 'response/batch', 'quasi_status', `x${junkString(8)}`];
  const OPS = ['APPEND', 'REPLACE', 'SET', '', junkString(4)];
  const TYPES = ['RESPONSE', 'THINKING', 'SEARCH', 'TIP', junkString(6)];
  const fragment = () => ({ type: pick(TYPES), content: junkString(14), extra: pick(JUNK_VALUE) });
  const junkChunk = () => pick([
    pick(JUNK_VALUE),
    { p: pick(PATHS), o: pick(OPS), v: pick(JUNK_VALUE) },
    { p: 'response/fragments', o: 'APPEND', v: Array.from({ length: int(4) }, () => pick([fragment(), pick(JUNK_VALUE)])) },
    { v: { response: { fragments: Array.from({ length: int(3) }, fragment) } } },
    { v: { text: junkString(12), fragments: Array.from({ length: int(2) }, fragment) } },
  ]);

  const SHAPE = ['searchStatus', 'status', 'text', 'thinking', 'usage'];
  let ok = true;
  for (let i = 0; i < 500; i += 1) {
    const chunk = junkChunk();
    let caseOk = true;
    try {
      const first = reduceChunk(chunk, { fragmentKind: 'text', tip: null });
      const replayed = reduceChunk(chunk, { fragmentKind: 'text', tip: null });
      caseOk = String(Object.keys(first).sort()) === String(SHAPE)
        && JSON.stringify(first) === JSON.stringify(replayed)
        && typeof first.text === 'string' && typeof first.thinking === 'string';
    } catch (error) {
      caseOk = false;
      console.log(`      junk case ${i} threw: ${error.message}`);
    }
    if (!caseOk) {
      ok = false;
      console.log(`      junk case ${i}: ${JSON.stringify(chunk)}`);
    }
  }
  // Sanity anchor: a real live delta still routes by the announced fragment kind.
  const state = { fragmentKind: 'text', tip: null };
  const live = reduceChunk({ p: 'response/fragments/-1/content', o: 'APPEND', v: '你好' }, state);
  ok = ok && live.text === '你好' && state.emittedText === '你好';
  check('reduceChunk: any junk chunk keeps the shape, never throws, replays identically', ok);
}

// -- parseArgs: JSON objects round-trip exactly; junk lands on undefined ------
{
  const KEYS = ['a', 'path', 'code', 'x1'];
  let ok = true;
  for (let i = 0; i < 300; i += 1) {
    const object = {};
    for (const key of KEYS.slice(0, 1 + int(KEYS.length))) {
      object[key] = pick([junkString(8).replace(/["\\]/g, '-'), int(1_000_000), true, false, null, -7]);
    }
    // parseArgs' first candidate is the raw JSON string, so the parse preserves
    // value identity for every JSON-safe primitive.
    const parsed = parseArgs(JSON.stringify(object));
    ok = ok && JSON.stringify(parsed) === JSON.stringify(object);
  }
  for (let i = 0; i < 500; i += 1) {
    const source = junkString(30);
    try {
      const result = parseArgs(source);
      ok = ok && (result === undefined || (result && typeof result === 'object' && !Array.isArray(result)));
    } catch {
      ok = false;
      console.log(`      junk case ${i}: ${JSON.stringify(source)} threw`);
    }
  }
  check('parseArgs: JSON objects round-trip exactly and junk answers undefined, never throws', ok);
}

// -- parseAnswer: fenced junk splits into typed blocks, cap holds, never throws
{
  const MAX_TOOL_CALLS = 99;
  const tool = (name, keys) => ({
    name,
    description: 'probe',
    parameters: { type: 'object', properties: Object.fromEntries(keys.map((key) => [key, { type: 'string' }])), required: keys.slice(0, 1) },
  });
  const catalog = [tool('fs1', ['path']), tool('echo', ['text', 'path']), tool('num', ['count'])];
  const PAYLOADS = ['{"path":"p"}', '{path:"p"}', 'main.py', '"p"', '[1,2]', '{"extra":1}', junkString(10), ''];
  const INFOS = ['fs1', 'FS1', 'json', '', 'unknown', junkString(6)];
  const SEGMENTS = ['text ', '中文', '\n', '```', junkString(8)];

  const junkAnswer = () => {
    let answer = '';
    for (let i = 0; i < 1 + int(6); i += 1) {
      answer += pick(SEGMENTS);
      if (random() < 0.55) answer += '```' + pick(INFOS) + '\n' + pick(PAYLOADS) + '\n```';
    }
    return answer;
  };
  const TOOL_JUNK = [[], null, undefined, catalog, {}, [null, { name: '' }, 42], [tool('a', ['path'])]];

  let ok = true;
  for (let i = 0; i < 500; i += 1) {
    const answer = junkAnswer();
    const tools = pick(TOOL_JUNK);
    try {
      const blocks = parseAnswer(answer, tools);
      const names = new Set((Array.isArray(tools) ? tools : []).filter((t) => t && typeof t.name === 'string').map((t) => t.name));
      let calls = 0;
      for (const block of blocks) {
        ok = ok && (block.type === 'text' || block.type === 'tool-call');
        if (block.type === 'tool-call') {
          calls += 1;
          const args = JSON.parse(block.arguments);
          ok = ok
            && names.has(block.name)
            && typeof block.arguments === 'string'
            && args !== null
            && typeof args === 'object';
        }
      }
      ok = ok && calls <= MAX_TOOL_CALLS;
      ok = ok && JSON.stringify(parseAnswer(answer, tools)) === JSON.stringify(blocks);
    } catch (error) {
      ok = false;
      console.log(`      junk case ${i}: ${JSON.stringify(answer)} -> ${error.message}`);
    }
  }

  // Empty catalog: fences stay visible text, byte-identical output.
  const fenced = 'text ```fs1\n{"path":"p"}\n``` tail';
  ok = ok && JSON.stringify(parseAnswer(fenced, [])) === JSON.stringify([{ type: 'text', text: fenced }]);

  // A named fence with a valid body becomes exactly one recognized call.
  const named = parseAnswer('head ```fs1\n{"path":"main.py"}\n``` tail', catalog);
  ok = ok
    && named.length === 3
    && named[1].type === 'tool-call'
    && named[1].name === 'fs1'
    && named[1].arguments === '{"path":"main.py"}';

  // An untagged fence is claimed only when ONE schema fits exactly; two
  // equally-fitting tools must leave it as text.
  const ambiguous = parseAnswer('```json\n{"path":"p"}\n```', [tool('a', ['path']), tool('b', ['path'])]);
  ok = ok && ambiguous.every((block) => block.type === 'text');
  const soloCalls = parseAnswer('```json\n{"path":"p"}\n```', [tool('solo', ['path'])]).filter((block) => block.type === 'tool-call');
  ok = ok && soloCalls.length === 1 && soloCalls[0].name === 'solo';

  // The cap: 101 valid calls execute 99; the rest stay visible text and the
  // truncation note closes the parse.
  const hundred = Array.from({ length: MAX_TOOL_CALLS + 2 }, () => '```fs1\n{"path":"x"}\n```').join('+');
  const capped = parseAnswer(hundred, catalog);
  ok = ok
    && capped.filter((block) => block.type === 'tool-call').length === MAX_TOOL_CALLS
    && capped.some((block) => block.type === 'text' && block.text.includes('fs1'))
    && capped.at(-1).text === `（本轮工具调用超过 ${MAX_TOOL_CALLS} 个，其余未执行）`;

  check(`parseAnswer: typed blocks, catalog-bound names, stringified args, ≤${MAX_TOOL_CALLS} calls, never throws`, ok);
}

console.log(failures === 0 ? 'invariants: all passing' : `\n${failures} failure(s), seed ${SEED}`);
process.exit(failures === 0 ? 0 : 1);
