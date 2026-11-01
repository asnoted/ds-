/**
 * Resolve the host's installed `@deepseek-ai/dsh-agent-loop`.
 *
 * A linked profile plugin cannot resolve `@deepseek-ai/dsh-*` bare imports, but
 * importing the same absolute file the host already loaded returns the cached
 * module instance, so a subclass shares the host's classes and services.
 *
 * @module dsh-dsb/host
 */

import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const LOOP_PACKAGE = join('@deepseek-ai', 'dsh-agent-loop', 'lib', 'index.js');
const DSH_PACKAGE = join('@deepseek-ai', 'dsh');

const PACKAGE = join('node_modules', '@deepseek-ai', 'dsh-agent-loop', 'lib', 'index.js');

function search(start) {
  let dir = start;
  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = join(dir, PACKAGE);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '';
}

/** Absolute path of the host loop module, or '' when it cannot be found. */
export function hostLoopPath() {
  let entry = '';
  try {
    entry = process.argv[1] ? realpathSync(process.argv[1]) : '';
  } catch {
    entry = '';
  }
  const found = (entry && search(dirname(entry))) || search(process.cwd());
  if (found) return found;
  // A test or a launcher that is not the dsh bin: explicit override first, then
  // the usual npm global prefixes with the loop nested under the dsh package.
  const override = String(process.env.DSH_AGENT_LOOP || '').trim();
  if (override && existsSync(override)) return override;
  for (const prefix of ['/opt/homebrew/lib/node_modules', '/usr/local/lib/node_modules']) {
    const candidate = join(prefix, DSH_PACKAGE, 'node_modules', LOOP_PACKAGE);
    if (existsSync(candidate)) return candidate;
  }
  return '';
}

export async function loadHostLoop() {
  const file = hostLoopPath();
  if (!file) throw new Error('dsb: cannot locate the host @deepseek-ai/dsh-agent-loop');
  const module = await import(pathToFileURL(file).href);
  const AgentLoop = module.AgentLoop ?? module.default;
  if (typeof AgentLoop !== 'function') throw new Error(`dsb: ${file} does not export AgentLoop`);
  return { file, AgentLoop };
}
