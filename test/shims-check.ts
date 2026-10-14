// Offline check of the shims src/shims.ts writes: run under a Node without type stripping, as
// an older Node is, the launcher names the Node version it needs, and the hook exits quietly.
//
//   node test/shims-check.ts

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeShims } from '../src/shims.ts';
import { check, finish } from './harness.ts';

const temp = mkdtempSync(join(tmpdir(), 'sh-'));
writeShims(join(import.meta.dirname, '..'), temp);
const withoutTypeStripping = (file: string) => spawnSync(process.execPath, ['--no-experimental-strip-types', file], { encoding: 'utf8', input: '{}', timeout: 20_000 });

await check('the launcher shim says which Node it needs when Node cannot strip types', () => {
	const result = withoutTypeStripping(join(temp, 'launcher.mjs'));
	assert.equal(result.status, 1);
	assert.match(result.stderr, /needs Node 22\.18 or later[^\n]*found v\d+\./);
});

await check('the hook shim exits quietly when Node cannot strip types', () => {
	const result = withoutTypeStripping(join(temp, 'prompt-hook.mjs'));
	assert.equal(result.status, 0);
	assert.equal(result.stdout + result.stderr, '');
});

rmSync(temp, { recursive: true, force: true });
finish();
