// Offline check of src/shell.ts: the command line it builds for a Windows shell passes each
// argument through whole, also from a folder whose name has a space.
//
//   node test/shell-check.ts

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandLine } from '../src/shell.ts';
import { check, finish, skip } from './harness.ts';

if (process.platform !== 'win32') {
	skip('commandLine passes each argument through a Windows shell whole', 'only Windows runs commands through a shell');
} else {
	await check('commandLine passes each argument through a Windows shell whole', () => {
		const temp = mkdtempSync(join(tmpdir(), 'sc-'));
		const folder = join(temp, 'a folder with spaces');
		mkdirSync(folder);
		const script = join(folder, 'echo.mjs');
		writeFileSync(script, 'console.log(JSON.stringify(process.argv.slice(2)));');
		const args = ['plain', 'two words', 'say "hi"', '', 'a&b', '(x)'];
		const result = spawnSync(commandLine(process.execPath, [script, ...args]), { shell: true, encoding: 'utf8' });
		rmSync(temp, { recursive: true, force: true });
		assert.deepEqual(JSON.parse(result.stdout), args, result.stderr);
	});
}

finish();
