/** Run every `test-*.mjs` in a package directory, sequentially. */
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(process.argv[2] || '.');
const files = readdirSync(root).filter((name) => /^test-.*\.mjs$/.test(name)).sort();

if (files.length === 0) {
  console.error(`no test-*.mjs under ${root}`);
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, [join(root, file)], { stdio: 'inherit' });
  if (result.status !== 0) {
    failed += 1;
    console.error(`FAIL ${file}`);
  }
}

console.log(failed === 0 ? `\n${files.length} suites passed` : `\n${failed} of ${files.length} suites failed`);
process.exit(failed === 0 ? 0 : 1);
