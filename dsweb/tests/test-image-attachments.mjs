// Agent conversations carry images as attachment refs, not bytes. The adapter
// must upload each one and pass the ids to the completion; a failure leaves
// the text placeholder and still lets the turn through.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSessionMap } from '../lib/session-map.js';
import { createWebModelAdapter } from '../lib/web-model.js';

const dir = mkdtempSync(join(tmpdir(), 'dsb-image-'));
const text = (role, body) => ({ role, content: [{ type: 'text', text: body }] });

const collect = async (stream) => {
  const out = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
};

try {
  {
    const uploads = [];
    const waits = [];
    const calls = [];
    const adapter = createWebModelAdapter({
      map: createSessionMap({ file: join(dir, 'a.json') }),
      token: () => 'token',
      pace: { wait: async () => {} },
      create: async () => 'web-a',
      upload: async (_token, file) => {
        uploads.push({ name: file.fileName, type: file.contentType, bytes: file.data.length });
        return { id: 'file-img-1', status: 'PENDING' };
      },
      awaitFiles: async (_token, ids) => {
        waits.push(ids);
        return [{ id: ids[0], status: 'SUCCESS' }];
      },
      resolveImage: async (ref) => ({ data: new Uint8Array([1, 2, 3, 4]) }),
      complete: async function* (_token, request) {
        calls.push(request);
        yield { type: 'text', text: 'a blue square' };
        yield { type: 'message', messageId: 3 };
      },
    });

    const image = {
      role: 'user',
      content: [
        { type: 'text', text: 'what colour is this?' },
        { type: 'image', attachment: { name: 'square.png', mediaType: 'image/png' } },
      ],
    };
    await collect(adapter.stream({
      sessionId: 's-image',
      toolHistory: [],
      messages: [image],
    }));

    assert.equal(uploads.length, 1, 'the image block is uploaded once');
    assert.equal(uploads[0].name, 'square.png');
    assert.equal(uploads[0].type, 'image/png');
    assert.equal(uploads[0].bytes, 4, 'the attachment bytes reach the upload');
    assert.deepEqual(waits, [['file-img-1']], 'the upload is awaited before the turn');
    assert.deepEqual(calls[0].refFileIds, ['file-img-1'], 'the completion references the uploaded file');
    assert.ok(calls[0].prompt.includes('what colour is this?'), 'the text prompt survives');
    assert.ok(calls[0].prompt.includes('square.png'), 'the placeholder names the image');
  }

  {
    // An upload that throws must not stop the turn.
    const calls = [];
    const adapter = createWebModelAdapter({
      map: createSessionMap({ file: join(dir, 'b.json') }),
      token: () => 'token',
      pace: { wait: async () => {} },
      create: async () => 'web-b',
      upload: async () => { throw new Error('upstream down'); },
      awaitFiles: async (_token, ids) => [{ id: ids[0], status: 'SUCCESS' }],
      resolveImage: async () => ({ data: new Uint8Array([9]) }),
      complete: async function* (_token, request) {
        calls.push(request);
        yield { type: 'text', text: 'I cannot see the image' };
        yield { type: 'message', messageId: 4 };
      },
    });

    const out = await collect(adapter.stream({
      sessionId: 's-fail',
      toolHistory: [],
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', attachment: { name: 'x.png', mediaType: 'image/png' } },
        ],
      }],
    }));

    assert.equal(calls.length, 1, 'the turn still reaches the model');
    assert.equal(calls[0].refFileIds, undefined, 'no file id is claimed when the upload failed');
    assert.equal(
      out.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''),
      'I cannot see the image',
    );
  }

  {
    // Without a resolver the adapter keeps its old text-only behaviour.
    const calls = [];
    const adapter = createWebModelAdapter({
      map: createSessionMap({ file: join(dir, 'c.json') }),
      token: () => 'token',
      pace: { wait: async () => {} },
      create: async () => 'web-c',
      complete: async function* (_token, request) {
        calls.push(request);
        yield { type: 'text', text: 'ok' };
        yield { type: 'message', messageId: 5 };
      },
    });
    await collect(adapter.stream({
      sessionId: 's-plain',
      toolHistory: [],
      messages: [text('user', 'hello')],
    }));
    assert.equal(calls[0].refFileIds, undefined, 'a text turn references no files');
  }

  console.log('ALL PASS — image attachments: 3 cases');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
