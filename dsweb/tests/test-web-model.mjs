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
  assert.ok(calls[0].prompt.startsWith('SYSTEM:\nyou are a test agent'), 'a system message leads the prompt');
  assert.match(calls[0].prompt, /USER:\nfirst question/);
  assert.equal(calls[0].sessionId, 'web-1');
  assert.deepEqual(chunks.filter((c) => c.type === 'block-start').map((c) => c.blockType), ['text']);
  assert.equal(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), 'hello');
  const end = chunks.find((c) => c.type === 'block-end');
  assert.deepEqual(end.block, { type: 'text', text: 'hello' });
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } });

  const second = [...first, text('assistant', 'hello'), text('user', 'second question')];
  const again = await collect(adapter.stream({ sessionId: 'dsh-1', toolHistory: [], messages: second }));
  assert.equal(creates.length, 1, 'the bound web session is reused');
  assert.equal(calls[1].prompt, 'second question', 'only the delta reaches the web session');
  assert.equal(calls[1].sessionId, 'web-1');
  assert.equal(map.parentFor('dsh-1'), 11, 'the assistant message id is remembered for the branch');
  assert.equal(calls[1].parentMessageId, 11, 'the next turn continues from that message');
  assert.equal(again.at(-1).reason.kind, 'stop');

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
    assert.equal(oneShot.at(-1).reason.kind, 'stop', 'a request without a session id is a one-shot turn');
    assert.equal(creates.length, 2, 'one-shot turns get their own web session');

    const before = creates.length;
    const auxiliary = await collect(adapter.stream({
      sessionId: 'aux-title',
      messages: [text('user', 'title me')],
    }));
    assert.equal(auxiliary.at(-1).reason.kind, 'stop');
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
          yield { type: 'text', text: 'let me read it\n```bash\n{"command":"cat a.txt"}\n```\n```js\n1+1\n```' };
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
    assert.match(asks[0].prompt, /"command"/, 'the catalog carries the tool schema, not a hand-written example');
    assert.ok(asks[0].prompt.includes('```TOOLNAME'), 'the taught protocol is a tool-name fence');
    assert.ok(asks[0].prompt.includes('as-is'), 'the prompt says a program goes in as-is');
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
      // The info line may carry the parameters instead of a body.
      const inlineAdapter = makeAdapter({
        map: createSessionMap({ file: join(dir, 'inline.json') }),
        token: () => 'token',
        create: async () => 'web-inline',
        complete: async function* () {
          yield { type: 'text', text: 'ok\n```shell ls```\n```bash {"command":"lsof -i :3080"}```\n```nope {"x":1}```\nnot a call: tools.bash({"command":"no"})' };
        },
      });
      const inlineOut = await collect(inlineAdapter.stream({
        sessionId: 'inline',
        toolHistory: [],
        messages: [text('user', 'go')],
        tools,
      }));
      const inlineCalls = inlineOut.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call');
      assert.equal(inlineCalls.length, 1, 'only a known tool fence is a call, got ' + inlineCalls.length);
      assert.equal(JSON.parse(inlineCalls[0].block.arguments).command, 'lsof -i :3080', 'the call argument is the command');
      const visible = inlineOut.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
      assert.match(visible, /```shell ls```/, 'an unknown fence tag stays text');
      assert.match(visible, /nope \{"x":1\}/, 'an unknown tool name stays text');
      assert.ok(visible.includes('tools.bash({"command":"no"})'), 'an SDK binding inside a sentence is not a direct call');
    }

    {
      // Code inside the JSON string arrives with raw newlines and bare quotes.
      const messy = makeAdapter({
        map: createSessionMap({ file: join(dir, 'messy.json') }),
        token: () => 'token',
        create: async () => 'web-messy',
        complete: async function* () {
          yield { type: 'text', text: '```bash\n{"command":"find dsweb -not -path "*/node_modules/*"\necho done"}\n```' };
        },
      });
      const messyOut = await collect(messy.stream({
        sessionId: 'messy',
        toolHistory: [],
        messages: [text('user', 'go')],
        tools,
      }));
      const messyCall = messyOut.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call');
      assert.equal(messyCall.block.name, 'bash', 'the call survives unescaped strings');
      assert.deepEqual(
        JSON.parse(messyCall.block.arguments),
        { command: 'find dsweb -not -path "*/node_modules/*"\necho done' },
        'raw newlines and bare quotes stay in the argument',
      );
    }

    {
      // A raw body is the argument itself; no JSON escaping involved.
      const rawAdapter = makeAdapter({
        map: createSessionMap({ file: join(dir, 'raw.json') }),
        token: () => 'token',
        create: async () => 'web-raw',
        complete: async function* () {
          yield { type: 'text', text: '```bash\nls -la && echo "hi"\n```' };
        },
      });
      const rawOut = await collect(rawAdapter.stream({
        sessionId: 'raw',
        toolHistory: [],
        messages: [text('user', 'go')],
        tools,
      }));
      const rawCall = rawOut.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call');
      assert.deepEqual(JSON.parse(rawCall.block.arguments), { command: 'ls -la && echo "hi"' }, 'the body is the command');

      const rawCodeTool = {
        name: 'run_code',
        description: 'Execute a program',
        parameters: {
          type: 'object',
          properties: { code: { type: 'string' }, description: { type: 'string' } },
          required: ['code', 'description'],
        },
      };
      const rawCode = makeAdapter({
        map: createSessionMap({ file: join(dir, 'raw-code.json') }),
        token: () => 'token',
        create: async () => 'web-raw-code',
        complete: async function* () {
          yield { type: 'text', text: '```run_code\nconst r = await tools.read({ file_path: "a.txt" });\nconsole.log(r.lines.length);\n```' };
        },
      });
      const rawCodeOut = await collect(rawCode.stream({
        sessionId: 'raw-code',
        toolHistory: [],
        messages: [text('user', 'go')],
        tools: [rawCodeTool],
      }));
      const rawCodeCall = rawCodeOut.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call');
      const rawCodeArgs = JSON.parse(rawCodeCall.block.arguments);
      assert.equal(rawCodeArgs.code, 'const r = await tools.read({ file_path: "a.txt" });\nconsole.log(r.lines.length);');
      assert.equal(rawCodeArgs.description, 'const r = await tools.read({ file_path: "a.txt" });', 'the first line labels the call');
    }

    {
      // The program carries unescaped quotes; plain JSON fails, so it is salvaged.
      const runCodeTool = {
        name: 'run_code',
        description: 'Execute a program',
        parameters: {
          type: 'object',
          properties: { code: { type: 'string' }, description: { type: 'string' } },
          required: ['code', 'description'],
        },
      };
      const salvaged = makeAdapter({
        map: createSessionMap({ file: join(dir, 'salvage.json') }),
        token: () => 'token',
        create: async () => 'web-salvage',
        complete: async function* () {
          yield { type: 'text', text: '```run_code\n{"code":"const r = await tools.read({\n  file_path: "a.txt",\n  limit: 5\n});","description":"Read a.txt"}\n```' };
        },
      });
      const salvagedOut = await collect(salvaged.stream({
        sessionId: 'salvage',
        toolHistory: [],
        messages: [text('user', 'go')],
        tools: [runCodeTool],
      }));
      const salvagedCall = salvagedOut.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call');
      assert.equal(salvagedCall.block.name, 'run_code');
      const salvagedArgs = JSON.parse(salvagedCall.block.arguments);
      assert.equal(salvagedArgs.description, 'Read a.txt');
      assert.ok(salvagedArgs.code.includes('"a.txt"'), 'inner quotes survive');
      assert.ok(salvagedArgs.code.includes('\n  limit: 5\n'), 'raw newlines survive');

      const bareSalvage = makeAdapter({
        map: createSessionMap({ file: join(dir, 'salvage-bare.json') }),
        token: () => 'token',
        create: async () => 'web-salvage-bare',
        complete: async function* () {
          yield { type: 'text', text: '```\n{"code":"const r = await tools.read({\n  file_path: "a.txt",\n  limit: 5\n});","description":"Read a.txt"}\n```' };
        },
      });
      const bareSalvageOut = await collect(bareSalvage.stream({
        sessionId: 'salvage-bare',
        toolHistory: [],
        messages: [text('user', 'go')],
        tools: [runCodeTool],
      }));
      const bareSalvageCall = bareSalvageOut.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call');
      assert.equal(bareSalvageCall.block.name, 'run_code', 'an untagged broken object is salvaged by its keys');
    }

    {
      // A lone parameter takes the whole body; its schema still decides the type.
      const waitTool = {
        name: 'wait',
        description: 'Wait a number of seconds',
        parameters: {
          type: 'object',
          properties: { seconds: { type: 'number' } },
          required: ['seconds'],
        },
      };
      const coerced = makeAdapter({
        map: createSessionMap({ file: join(dir, 'coerced.json') }),
        token: () => 'token',
        create: async () => 'web-coerced',
        complete: async function* () {
          yield { type: 'text', text: '```wait {"seconds":"42"}```' };
        },
      });
      const coercedOut = await collect(coerced.stream({
        sessionId: 'coerced',
        toolHistory: [],
        messages: [text('user', 'wait a bit')],
        tools: [waitTool],
      }));
      const coercedCall = coercedOut.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call');
      assert.deepEqual(JSON.parse(coercedCall.block.arguments), { seconds: 42 }, 'the tool schema decides the argument type');
      assert.deepEqual(coercedOut.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } });
    }

    {
      // The ptc preset exposes only run_code. Teaching a direct bash call here
      // makes the model emit a bash invoke the adapter must reject as unknown.
      const runCode = {
        name: 'run_code',
        description: 'Execute a TypeScript program against the available tools',
        parameters: {
          type: 'object',
          properties: { code: { type: 'string' }, description: { type: 'string' } },
          required: ['code', 'description'],
        },
      };
      const ptcAsks = [];
      const ptc = makeAdapter({
        map: createSessionMap({ file: join(dir, 'ptc.json') }),
        token: () => 'token',
        create: async () => 'web-ptc',
        complete: async function* (_token, request) {
          ptcAsks.push(request);
          yield { type: 'text', text: '```run_code\n{"code":"console.log(1)","description":"Print"}\n```' };
        },
      });
      const ptcOut = await collect(ptc.stream({
        sessionId: 'ptc',
        toolHistory: [],
        messages: [text('user', 'pwd')],
        tools: [runCode],
      }));
      assert.match(ptcAsks[0].prompt, /- run_code:/);
      assert.ok(!ptcAsks[0].prompt.includes('```bash'), 'no direct bash example when bash is not a tool');
      assert.match(ptcAsks[0].prompt, /"code"/, 'the catalog carries the tool schema, not a hand-written example');
      const ptcCall = ptcOut.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call');
      assert.deepEqual(
        JSON.parse(ptcCall.block.arguments),
        { code: 'console.log(1)', description: 'Print' },
        'the native call object is taken as the arguments',
      );
    }

    {
      // The web model sometimes writes the arguments object on its own, with no
      // tool tag. Exactly one schema must fit, or the JSON stays text.
      const bareRunCode = {
        name: 'run_code',
        description: 'Execute a TypeScript program against the available tools',
        parameters: {
          type: 'object',
          properties: { code: { type: 'string' }, description: { type: 'string' } },
          required: ['code', 'description'],
        },
      };
      const bare = makeAdapter({
        map: createSessionMap({ file: join(dir, 'bare.json') }),
        token: () => 'token',
        create: async () => 'web-bare',
        complete: async function* () {
          yield { type: 'text', text: '```\n{"code":"console.log(1)","description":"Print"}\n```' };
        },
      });
      const bareOut = await collect(bare.stream({
        sessionId: 'bare',
        toolHistory: [],
        messages: [text('user', 'print one')],
        tools: [bareRunCode],
      }));
      const bareCall = bareOut.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call');
      assert.equal(bareCall.block.name, 'run_code', 'a bare arguments object runs when its schema fits');
      assert.deepEqual(JSON.parse(bareCall.block.arguments), { code: 'console.log(1)', description: 'Print' });

      const sample = makeAdapter({
        map: createSessionMap({ file: join(dir, 'sample.json') }),
        token: () => 'token',
        create: async () => 'web-sample',
        complete: async function* () {
          yield { type: 'text', text: '```json\n{"name":"x","value":1}\n```' };
        },
      });
      const sampleOut = await collect(sample.stream({
        sessionId: 'sample',
        toolHistory: [],
        messages: [text('user', 'show me json')],
        tools: [bareRunCode],
      }));
      assert.equal(
        sampleOut.filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call').length,
        0,
        'a JSON sample that fits no schema stays text',
      );
    }

    {
      // A bound web chat keeps the prompt it was created with. A new prompt
      // version must start a fresh web session, or the old catalog stays live.
      const staleMap = createSessionMap({ file: join(dir, 'stale-prompt.json') });
      staleMap.bind('stale', 'web-stale');
      let creates = 0;
      const stale = makeAdapter({
        map: staleMap,
        token: () => 'token',
        create: async () => {
          creates += 1;
          return 'web-stale-new';
        },
        complete: async function* () {
          yield { type: 'text', text: 'ok' };
        },
      });
      await collect(stale.stream({ sessionId: 'stale', toolHistory: [], messages: [text('user', 'q')] }));
      assert.equal(creates, 1, 'a stale prompt version rebuilds the web session');
      assert.equal(staleMap.webSessionFor('stale'), 'web-stale-new');
    }

    {
      // DSH owns the tool list. When it changes, the bound web chat must rebuild
      // so the model sees the new catalog instead of the one it first received.
      const changeMap = createSessionMap({ file: join(dir, 'tool-change.json') });
      const prompts = [];
      let creates = 0;
      const changing = makeAdapter({
        map: changeMap,
        token: () => 'token',
        create: async () => {
          creates += 1;
          return `web-change-${creates}`;
        },
        complete: async function* (_token, request) {
          prompts.push(request.prompt);
          yield { type: 'text', text: 'ok' };
        },
      });
      const bashTool = { name: 'bash', description: 'Run a shell command', parameters: { type: 'object', properties: { command: { type: 'string' } } } };
      const readTool = { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } };
      const messages = [text('user', 'go')];
      await collect(changing.stream({ sessionId: 'change', toolHistory: [], messages, tools: [bashTool] }));
      await collect(changing.stream({ sessionId: 'change', toolHistory: [], messages, tools: [readTool] }));
      assert.equal(creates, 2, 'a changed tool catalog rebuilds the web session');
      assert.match(prompts[1], /- read:/);
      assert.ok(!prompts[1].includes('- bash:'), 'the rebuild carries the current catalog');
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

    const many = Array.from({ length: 12 }, (_, i) => '```bash\n{"command":"cat f' + i + '"}\n```').join('\n');
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
    assert.equal(driftMap.parentFor('dsh-drift'), 99, 'the map adopts the web branch tip');
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
    assert.deepEqual(chunks, [{ type: 'finish', reason: { kind: 'stop' } }], 'a system-only turn ends quietly');
  }
  console.log('web model: all passing');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
