// The protocol parser must survive the tag spellings a model actually emits:
// an uppercased tool name, and CRLF line endings from a non-Unix client.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSessionMap } from '../lib/session-map.js';
import { createWebModelAdapter } from '../lib/web-model.js';

const dir = mkdtempSync(join(tmpdir(), 'dsb-protocol-'));

const text = (role, body) => ({ role, content: [{ type: 'text', text: body }] });
const tools = [{
  name: 'bash',
  description: 'Run a shell command',
  parameters: {
    type: 'object',
    properties: { command: { type: 'string' } },
    required: ['command'],
  },
}];

const CRLF = String.fromCharCode(13) + String.fromCharCode(10);
const FENCE = String.fromCharCode(96, 96, 96);

const adapterFor = (answer, file) => createWebModelAdapter({
  map: createSessionMap({ file: join(dir, file) }),
  token: () => 'token',
  pace: { wait: async () => {} },
  create: async () => 'web-' + file,
  complete: async function* () {
    yield { type: 'text', text: answer };
    yield { type: 'message', messageId: 1 };
  },
});

const callsOf = async (answer, file) => {
  const out = [];
  for await (const chunk of adapterFor(answer, file).stream({
    sessionId: file,
    toolHistory: [],
    messages: [text('user', 'go')],
    tools,
  })) {
    if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') out.push(chunk.block);
  }
  return out;
};

try {
  {
    const answer = FENCE + 'BASH' + CRLF + '{"command":"cat a.txt"}' + CRLF + FENCE;
    const calls = await callsOf(answer, 'upper.json');
    assert.equal(calls.length, 1, 'an uppercased tag still names a catalog tool');
    assert.equal(calls[0].name, 'bash', 'the call is reported under the catalog spelling');
    assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'cat a.txt' });
  }

  {
    const answer = FENCE + 'bash' + CRLF + '{"command":"ls -la"}' + CRLF + FENCE;
    const calls = await callsOf(answer, 'crlf.json');
    assert.equal(calls.length, 1, 'a CRLF fence is still a call');
    assert.equal(calls[0].name, 'bash', 'the CR is not part of the tool name');
    assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'ls -la' });
  }

  {
    const answer = FENCE + 'BASH' + CRLF + 'ls -la' + CRLF + FENCE;
    const calls = await callsOf(answer, 'upper-raw.json');
    assert.equal(calls.length, 1, 'an uppercased raw body is still a call');
    assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'ls -la' });
  }

  console.log('ALL PASS — protocol variants: 3 cases');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
