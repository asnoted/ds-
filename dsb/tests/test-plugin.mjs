import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { hostLoopPath } from '../lib/host.js';

const file = hostLoopPath();
if (!existsSync(file)) {
  console.log('loop plugin: host @deepseek-ai/dsh-agent-loop not found, skipping');
  process.exit(0);
}

const module = await import('../lib/index.js');
assert.equal(typeof module.ChatLoop, 'function');
assert.equal(module.default, module.ChatLoop);
assert.ok(file.includes('dsh-agent-loop'), `host loop path: ${file}`);
assert.ok(['function', 'object'].includes(typeof module.ChatLoop.Config));
console.log('loop plugin: host subclass loads');
