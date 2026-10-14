// Offline check of package.json and .vscodeignore: the package script passes vsce the flags this
// extension needs, and the VSIX takes no file that is only on this machine and drops none that the
// extension imports.
//
//   node test/manifest-check.ts

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { check, finish } from './harness.ts';
import { reachableFiles } from './imports.ts';

const root = join(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { activationEvents: string[]; icon?: string; scripts: Record<string, string> };

await check('the package script allows the * activation event, so vsce does not stop to ask in a terminal', () => {
	assert.ok(manifest.activationEvents.includes('*'));
	assert.match(manifest.scripts['package'] ?? '', /--allow-star-activation/);
});

const vsixFiles = execFileSync(process.execPath, [join(root, 'node_modules', '@vscode', 'vsce', 'vsce'), 'ls'], { cwd: root, encoding: 'utf8' })
	.split(/\r?\n/)
	.filter(path => path && !path.startsWith('node_modules/'));

await check('the VSIX holds only tracked files and node_modules', () => {
	const tracked = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0'));
	assert.deepEqual(vsixFiles.filter(path => !tracked.has(path)), []);
});

await check('the manifest names a square PNG icon of at least 128 px, and the VSIX holds it', () => {
	assert.ok(manifest.icon, 'package.json has no icon');
	const png = readFileSync(join(root, manifest.icon));
	assert.equal(png.subarray(1, 4).toString(), 'PNG');
	const width = png.readUInt32BE(16);
	assert.equal(png.readUInt32BE(20), width, 'the icon is not square');
	assert.ok(width >= 128, `the icon is ${width} px wide`);
	assert.ok(vsixFiles.includes(manifest.icon));
});

await check('the VSIX holds every file the extension imports, plugin/scripts/discovery.ts included', () => {
	const imported = reachableFiles(join(root, 'src', 'extension.ts')).map(file => relative(root, file).replaceAll('\\', '/'));
	assert.ok(imported.includes('plugin/scripts/discovery.ts'), 'the walk did not reach discovery.ts');
	assert.deepEqual(imported.filter(path => !vsixFiles.includes(path)), []);
});

finish();
