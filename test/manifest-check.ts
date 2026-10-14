// Offline check of package.json and .vscodeignore: the package script passes vsce the flags this
// extension needs, and the VSIX takes no file that is only on this machine.
//
//   node test/manifest-check.ts

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, finish } from './harness.ts';

const root = join(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { activationEvents: string[]; scripts: Record<string, string> };

await check('the package script allows the * activation event, so vsce does not stop to ask in a terminal', () => {
	assert.ok(manifest.activationEvents.includes('*'));
	assert.match(manifest.scripts['package'] ?? '', /--allow-star-activation/);
});

await check('the VSIX holds only tracked files and node_modules', () => {
	const tracked = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0'));
	const packed = execFileSync(process.execPath, [join(root, 'node_modules', '@vscode', 'vsce', 'vsce'), 'ls'], { cwd: root, encoding: 'utf8' })
		.split(/\r?\n/)
		.filter(path => path && !path.startsWith('node_modules/'));
	assert.deepEqual(packed.filter(path => !tracked.has(path)), []);
});

finish();
