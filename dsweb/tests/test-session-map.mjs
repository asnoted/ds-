/**
 * The DSH↔web session map: deltas, digests, and the rebuild trigger.
 *
 * The rebuild path is the load-bearing one. If compaction or an edited log is
 * not detected, the next step sends a delta on top of history the web session
 * still holds, and the model answers from a transcript DSH can no longer
 * reconstruct — which is exactly the failure this map exists to prevent.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSessionMap } from '../lib/session-map.js';

const dir = mkdtempSync(join(tmpdir(), 'dsb-session-map-'));
const file = join(dir, 'web-sessions.json');
const msg = (role, text) => ({ role, content: [{ type: 'text', text }] });

try {
  const first = [msg('user', 'one'), msg('assistant', 'two')];

  {
    const map = createSessionMap({ file });
    assert.deepEqual(map.pending('dsh-1', first), { fresh: first, rebuild: true, cursor: 0 });
    map.bind('dsh-1', 'web-1');
    assert.equal(map.webSessionFor('dsh-1'), 'web-1');
    assert.equal(map.parentFor('dsh-1'), 0);
    assert.equal(map.setParent('dsh-1', 11), true);
    assert.deepEqual(map.pending('dsh-1', first), { fresh: first, rebuild: false, cursor: 0 });
    assert.equal(map.commit('dsh-1', first), true);
  }

  {
    const map = createSessionMap({ file });
    assert.equal(map.parentFor('dsh-1'), 11, 'the branch tip survives a reload');
    const grown = [...first, msg('user', 'three')];
    const pending = map.pending('dsh-1', grown);
    assert.equal(pending.rebuild, false);
    assert.equal(pending.cursor, 2);
    assert.deepEqual(pending.fresh, [grown[2]]);
    assert.equal(map.commit('dsh-1', grown), true);
  }

  {
    const map = createSessionMap({ file });
    const rewritten = [msg('user', 'one (edited)'), msg('assistant', 'two'), msg('user', 'three')];
    const pending = map.pending('dsh-1', rewritten);
    assert.equal(pending.rebuild, true, 'an edited prefix must rebuild');
    assert.deepEqual(pending.fresh, rewritten);
  }

  {
    const map = createSessionMap({ file });
    const compacted = [msg('user', 'summary'), msg('assistant', 'two'), msg('user', 'three')];
    assert.equal(map.pending('dsh-1', compacted).rebuild, true, 'a shorter log must rebuild');
  }

  {
    const map = createSessionMap({ file });
    map.bind('dsh-2', 'web-2');
    assert.equal(map.webSessionFor('dsh-1'), 'web-1', 'binding one session must not disturb another');
    map.forget('dsh-2');
    assert.equal(map.webSessionFor('dsh-2'), '');
  }

  {
    const many = { version: 1, sessions: {} };
    for (let i = 0; i < 201; i += 1) {
      many.sessions[`dsh-${i}`] = { webSessionId: `web-${i}`, parentMessageId: 0, cursor: 0, digest: '', updatedAt: new Date(2026, 0, 1, 0, 0, i).toISOString() };
    }
    writeFileSync(file, JSON.stringify(many));
    const map = createSessionMap({ file });
    assert.equal(map.webSessionFor('dsh-0'), '', 'the oldest session must be trimmed');
    assert.equal(map.webSessionFor('dsh-200'), 'web-200', 'the newest session survives');
    map.bind('dsh-new', 'web-new');
    const reloaded = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(Object.keys(reloaded.sessions).length, 200, 'the map stays bounded at 200');
  }

  console.log('session map: all passing');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
