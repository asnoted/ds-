/**
 * The `deepseek-web` model route: one web session per DSH session, delta
 * prompts on later steps, and a single web turn in flight.
 *
 * The fakes replace the wire, not the adapter: `create`/`complete` are injected
 * exactly where the real web calls sit, so the prompt a step would send and the
 * order turns take are what this suite asserts.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSessionMap } from '../lib/session-map.js';
import { createWebModelAdapter, MODEL, PROVIDER } from '../lib/web-model.js';

const noPace = { wait: async () => {} };
const makeAdapter = (options = {}) =>
  createWebModelAdapter({ pace: noPace, history: async () => null, ...options });

const dir = mkdtempSync(join(tmpdir(), 'dsb-web-model-'));
const file = join(dir, 'map.json');
const text = (role, value) => ({ role, content: [{ type: 'text', text: value }] });

const collect = async (iterable) => {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

try {
  const map = createSessionMap({ file });
  const creates = [];
  const calls = [];
  const adapter = makeAdapter({
    map,
    token: () => 'token',
    create: async () => {
      creates.push(creates.length + 1);
      return `web-${creates.length}`;
    },
    complete: async function* (_token, request) {
      calls.push(request);
      yield { type: 'text', text: 'hello' };
      yield { type: 'message', messageId: 11 };
      yield { type: 'done', status: 'FINISHED' };
    },
  });

  const system = text('system', 'you are a test agent');
  const first = [system, text('user', 'first question')];
  const catalog = await adapter.listModels(PROVIDER);
  assert.equal(catalog[0].provider, PROVIDER, 'a catalog entry without its provider route is rejected by the host');
  assert.equal(catalog[0].id, MODEL);
  const chunks = await collect(adapter.stream({ sessionId: 'dsh-1', toolHistory: [], messages: first }));

  assert.equal(creates.length, 1);
  assert.equal(map.webSessionFor('dsh-1'), 'web-1');
  assert.match(calls[0].prompt, /SYSTEM:\nyou are a test agent/, 'the first turn carries the system prompt');
  assert.match(calls[0].prompt, /USER:\nfirst question/);
  assert.equal(calls[0].sessionId, 'web-1');
  assert.deepEqual(chunks.filter((c) => c.type === 'block-start').map((c) => c.blockType), ['text']);
  assert.equal(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), 'hello');
  const end = chunks.find((c) => c.type === 'block-end');
  assert.deepEqual(end.block, { type: 'text', text: 'hello' });
  assert.deepEqual(chunks.at(-1), { type: 'finish', kind: 'stop' });

  const second = [...first, text('assistant', 'hello'), text('user', 'second question')];
  const again = await collect(adapter.stream({ sessionId: 'dsh-1', toolHistory: [], messages: second }));
  assert.equal(creates.length, 1, 'the bound web session is reused');
  assert.equal(calls[1].prompt, 'second question', 'only the delta reaches the web session');
  assert.equal(calls[1].sessionId, 'web-1');
  assert.equal(map.parentFor('dsh-1'), 11, 'the assistant message id is remembered for the branch');
  assert.equal(calls[1].parentMessageId, 11, 'the next turn continues from that message');
  assert.equal(again.at(-1).kind, 'stop');

  {
    let open;
    const started = [];
    const blocking = makeAdapter({
      map: createSessionMap({ file: join(dir, 'lock.json') }),
      token: () => 'token',
      create: async () => 'web-lock',
      complete: async function* (_token, request) {
        started.push(request.prompt);
        if (started.length === 1) await new Promise((resolve) => { open = resolve; });
        yield { type: 'text', text: 'ok' };
      },
    });
    const one = blocking.stream({ sessionId: 'a', toolHistory: [], messages: [text('user', 'A')] });
    const firstNext = one.next();
    await tick();
    const two = blocking.stream({ sessionId: 'b', toolHistory: [], messages: [text('user', 'B')] });
    const secondNext = two.next();
    await tick();
    assert.deepEqual(started, ['USER:\nA'], 'the second turn must wait for the first');
    open();
    await firstNext;
    await collect({ [Symbol.asyncIterator]: () => one });
    await secondNext;
    await collect({ [Symbol.asyncIterator]: () => two });
    assert.deepEqual(started, ['USER:\nA', 'USER:\nB'], 'the queued turn runs next');
  }

  {
    let fail = true;
    const flakyMap = createSessionMap({ file: join(dir, 'flaky.json') });
    const rebuilt = [];
    const flaky = makeAdapter({
      map: flakyMap,
      token: () => 'token',
      create: async () => {
        rebuilt.push(rebuilt.length + 1);
        return `web-flaky-${rebuilt.length}`;
      },
      complete: async function* () {
        if (fail) throw new Error('upstream down');
        yield { type: 'text', text: 'recovered' };
      },
    });
    await assert.rejects(collect(flaky.stream({ sessionId: 'c', toolHistory: [], messages: [text('user', 'C')] })), /upstream down/);
    assert.equal(flakyMap.webSessionFor('c'), '', 'a session that failed before any message is forgotten');
    fail = false;
    const recovered = await collect(flaky.stream({ sessionId: 'c', toolHistory: [], messages: [text('user', 'C')] }));
    assert.equal(rebuilt.length, 2, 'the retry creates a new web session');
    assert.equal(flakyMap.webSessionFor('c'), 'web-flaky-2', 'the retry is bound to the new session');
    assert.equal(recovered.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), 'recovered');
  }

  {
    const partialMap = createSessionMap({ file: join(dir, 'partial.json') });
    const partial = makeAdapter({
      map: partialMap,
      token: () => 'token',
      create: async () => 'web-partial',
      complete: async function* () {
        yield { type: 'text', text: 'half an answer' };
        throw new Error('cut');
      },
    });
    await assert.rejects(
      collect(partial.stream({ sessionId: 'partial', toolHistory: [], messages: [text('user', 'P')] })),
      /cut/,
    );
    assert.equal(
      partialMap.webSessionFor('partial'),
      'web-partial',
      'a session that already produced output keeps its branch',
    );
  }

  {
    const oneShot = await collect(adapter.stream({ messages: [text('user', 'title me')] }));
    assert.equal(oneShot.at(-1).kind, 'stop', 'a request without a session id is a one-shot turn');
    assert.equal(creates.length, 2, 'one-shot turns get their own web session');

    const before = creates.length;
    const auxiliary = await collect(adapter.stream({
      sessionId: 'aux-title',
      messages: [text('user', 'title me')],
    }));
    assert.equal(auxiliary.at(-1).kind, 'stop');
    assert.equal(map.webSessionFor('aux-title'), '', 'a title/compaction call must not bind the conversation');
    assert.equal(creates.length, before + 1, 'it still gets its own web session');
  }

  {
    const tools = [{
      name: 'bash',
      description: 'Run a shell command',
      parameters: { type: 'object', properties: { command: { type: 'string' } } },
    }];
    const asks = [];
    const toolMap = createSessionMap({ file: join(dir, 'tools.json') });
    const withTools = makeAdapter({
      map: toolMap,
      token: () => 'token',
      create: async () => 'web-tools',
      complete: async function* (_token, request) {
        asks.push(request);
        if (asks.length === 1) {
          yield { type: 'text', text: 'let me read it\n```shell\ncat a.txt\n```\n```js\n1+1\n```' };
          yield { type: 'message', messageId: 7 };
        } else {
          yield { type: 'text', text: 'the file says hi' };
          yield { type: 'message', messageId: 9 };
        }
      },
    });
    const toolTurn = await collect(withTools.stream({
      sessionId: 'with-tools',
      toolHistory: [],
      messages: [text('user', 'read a.txt')],
      tools,
    }));
    assert.match(asks[0].prompt, /TOOL CATALOG/);
    assert.match(asks[0].prompt, /- bash: Run a shell command/);
    assert.ok(asks[0].prompt.includes('```shell'), 'the taught protocol is the shell fence');
    assert.ok(!asks[0].prompt.includes('```tool_name'), 'bash is the only tool exposed');
    assert.ok(!asks[0].prompt.includes('invoke name'), 'the prompt must not teach the DSML invoke protocol');
    const call = toolTurn.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call');
    assert.equal(call.block.name, 'bash');
    assert.deepEqual(JSON.parse(call.block.arguments), { command: 'cat a.txt' });
    assert.ok(
      toolTurn.some((chunk) => chunk.type === 'text-delta' && chunk.text.includes('let me read it')),
      'text before the call survives',
    );
    assert.ok(
      toolTurn.some((chunk) => chunk.type === 'text-delta' && chunk.text.includes('```js')),
      'a non-tool fence stays visible text',
    );

    const assistantCall = {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"cat a.txt"}' }],
    };
    const toolResult = { role: 'tool', content: [{ type: 'text', text: 'hi' }] };
    const after = await collect(withTools.stream({
      sessionId: 'with-tools',
      toolHistory: [],
      messages: [text('user', 'read a.txt'), assistantCall, toolResult],
      tools,
    }));
    assert.equal(asks[1].prompt, 'TOOL:\nhi', 'the tool result is the next delta');
    assert.equal(asks[1].parentMessageId, 7, 'the tool turn continues the same branch');
    assert.ok(!asks[1].prompt.includes('TOOL CATALOG'), 'the catalog is not re-sent');
    assert.equal(after.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join(''), 'the file says hi');

    {
      const shellMap = createSessionMap({ file: join(dir, 'shell.json') });
      const shellAsks = [];
      const shellAdapter = makeAdapter({
        map: shellMap,
        token: () => 'token',
        create: async () => 'web-shell',
        complete: async function* (_token, request) {
          shellAsks.push(request);
          yield {
            type: 'text',
            text: 'checking\n```shell\nlsof -i :3080\n```\n```bash\n{"command":"echo nope"}\n```',
          };
          yield { type: 'message', messageId: 12 };
        },
      });
      const shellOut = await collect(shellAdapter.stream({
        sessionId: 'shell',
        toolHistory: [],
        messages: [text('user', 'check the port')],
        tools: [{
          name: 'bash',
          description: 'Run a shell command',
          parameters: { type: 'object', properties: { command: { type: 'string' } } },
        }],
      }));
      assert.match(shellAsks[0].prompt, /```shell/, 'the prompt teaches the shell fence');
      const calls = shellOut.filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call');
      assert.equal(calls.length, 1, 'only the shell fence is a call');
      assert.equal(calls[0].block.name, 'bash');
      assert.deepEqual(JSON.parse(calls[0].block.arguments), { command: 'lsof -i :3080' });
      const visible = shellOut.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('');
      assert.match(visible, /```bash/, 'a bash fence stays text');
    }
    {
      // A model may put a word after the fence tag; the first token still names
      // the tool and the rest joins the command, so it must run (was: silently text).
      const looseAdapter = makeAdapter({
        map: createSessionMap({ file: join(dir, 'loose.json') }),
        token: () => 'token',
        create: async () => 'web-loose',
        complete: async function* () {
          yield { type: 'text', text: 'ok\n```shell extra\nls\n```' };
          yield { type: 'message', messageId: 30 };
        },
      });
      const looseOut = await collect(looseAdapter.stream({
        sessionId: 'loose',
        toolHistory: [],
        messages: [text('user', 'go')],
        tools,
      }));
      const looseCall = looseOut.find((c) => c.type === 'block-end' && c.block.type === 'tool-call');
      assert.equal(looseCall.block.name, 'bash', 'a word after the fence tag still names bash');
      assert.equal(JSON.parse(looseCall.block.arguments).command, 'extra\nls', 'the tag remnant joins the command');
    }

    {
      const echoAsks = [];
      const echoAdapter = makeAdapter({
        map: createSessionMap({ file: join(dir, 'echo.json') }),
        token: () => 'token',
        create: async () => 'web-echo',
        complete: async function* (_token, request) {
          echoAsks.push(request);
          if (echoAsks.length === 1) {
            yield { type: 'text', text: '<result name=shell>\n<name>bash</name>\n<output>hi</output>\n</result>' };
            yield { type: 'message', messageId: 21 };
          } else {
            yield { type: 'text', text: 'the directory has README.md and dsweb' };
            yield { type: 'message', messageId: 22 };
          }
        },
      });
      const echoOut = await collect(echoAdapter.stream({
        sessionId: 'echo',
        toolHistory: [],
        messages: [text('user', 'look around'), { role: 'tool', content: [{ type: 'text', text: 'hi' }] }],
        tools,
      }));
      assert.equal(echoAsks.length, 2, 'a pure result echo is retried once');
      assert.match(echoAsks[1].prompt, /继续/);
      assert.equal(
        echoOut.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join(''),
        'the directory has README.md and dsweb',
      );
    }


    const many = Array.from({ length: 12 }, (_, i) => `\u0060\u0060\u0060shell\ncat f${i}\n\u0060\u0060\u0060`).join('\n');
    const capped = makeAdapter({
      map: createSessionMap({ file: join(dir, 'cap.json') }),
      token: () => 'token',
      create: async () => 'web-cap',
      complete: async function* () {
        yield { type: 'text', text: many };
        yield { type: 'message', messageId: 5 };
      },
    });
    const cappedChunks = await collect(capped.stream({
      sessionId: 'cap',
      toolHistory: [],
      messages: [text('user', 'do many things')],
      tools,
    }));
    const capCalls = cappedChunks.filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call');
    assert.equal(capCalls.length, 9, 'a runaway answer is capped at nine tool calls');
    assert.ok(
      cappedChunks.some((chunk) => chunk.type === 'text-delta' && chunk.text.includes('超过 9 个')),
      'the cap is reported to the reader',
    );
  }

  {
    let waits = 0;
    const counted = createWebModelAdapter({
      map: createSessionMap({ file: join(dir, 'paced.json') }),
      token: () => 'token',
      create: async () => 'web-paced',
      complete: async function* () {
        yield { type: 'text', text: 'ok' };
      },
      pace: { wait: async () => { waits += 1; } },
    });
    await collect(counted.stream({ sessionId: 'paced', toolHistory: [], messages: [text('user', 'x')] }));
    assert.equal(waits, 1, 'each turn goes through the outbound pace');
  }

  {
    // The web app is a second writer: appending there moves the tip off the id
    // the map recorded, and the next DSH step must rebuild instead of sending a
    // delta on a branch DSH never saw.
    const driftMap = createSessionMap({ file: join(dir, 'map-drift.json') });
    let tip = 0;
    const created = [];
    const sent = [];
    const drift = makeAdapter({
      map: driftMap,
      token: () => 'token',
      history: async () => [{ role: 'assistant', id: tip }],
      create: async () => {
        created.push(created.length + 1);
        return `web-${created.length}`;
      },
      complete: async function* (_token, request) {
        sent.push(request);
        yield { type: 'text', text: 'hi' };
        yield { type: 'message', messageId: 11 };
        yield { type: 'done', status: 'FINISHED' };
      },
    });
    const m1 = [text('user', 'q1')];
    await collect(drift.stream({ sessionId: 'dsh-drift', toolHistory: [], messages: m1 }));
    tip = 11; // the web answer DSH just produced
    const m2 = [...m1, text('assistant', 'hi'), text('user', 'q2')];
    await collect(drift.stream({ sessionId: 'dsh-drift', toolHistory: [], messages: m2 }));
    assert.equal(created.length, 1, 'a matching web tip reuses the session');

    tip = 99; // someone appended on chat.deepseek.com
    await collect(drift.stream({ sessionId: 'dsh-drift', toolHistory: [], messages: m2 }));
    assert.equal(created.length, 1, 'a drifted web tip must not fork a new web session');
    assert.equal(created.length, 1, 'a drifted web tip must not fork a new web session');
    assert.equal(driftMap.parentFor('dsh-drift'), 99, 'the map adopts the web branch tip');    assert.equal(driftMap.parentFor('dsh-drift'), 99, 'the map adopts the web branch tip');
  }

  {
    // A rebuild with only a system prompt and no real question used to send the
    // whole tool catalog as a user message; the web model then answered "what do
    // you want?" and that phantom turn poisoned the session. No question, no send.
    const emptyMap = createSessionMap({ file: join(dir, 'map-empty.json') });
    let created = 0;
    const empty = makeAdapter({
      map: emptyMap,
      token: () => 'token',
      create: async () => { created += 1; return 'web-empty'; },
      complete: async function* () {
        throw new Error('a turn with no question must not reach the web');
      },
    });
    const chunks = await collect(
      empty.stream({ sessionId: 'dsh-empty', toolHistory: [], messages: [text('system', 'only a system prompt')] }),
    );
    assert.equal(created, 0, 'an empty turn must not create a web session');
    assert.deepEqual(chunks, [{ type: 'finish', kind: 'stop' }], 'a system-only turn ends quietly');
  }
  console.log('web model: all passing');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
