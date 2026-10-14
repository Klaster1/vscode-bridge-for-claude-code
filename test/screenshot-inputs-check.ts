// Offline check of scripts/screenshot-inputs.ts: what makes the recorded screenshot inputs stale,
// in a throwaway git repository.
//
//   node test/screenshot-inputs-check.ts

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { hashInputs } from '../scripts/screenshot-inputs.ts';
import { check, finish } from './harness.ts';

const root = mkdtempSync(join(tmpdir(), 'si-'));
const write = (path: string, text: string) => {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), text);
};
const manifest = (version: string, description = 'A description.') => `${JSON.stringify({ name: 'x', version, description, contributes: { configuration: {} } }, null, 2)}\n`;
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });

execFileSync('git', ['init', '-q', root]);
write('package.json', manifest('1.0.0'));
write('scripts/generate-screenshots.ts', 'generate\n');
write('scripts/screenshot-inputs.ts', 'inputs\n');
write('scripts/screenshot-fixture/readme.md', 'fixture\n');
write('scripts/social-preview.html', '<p>preview</p>\n');
write('src/extension.ts', 'a\n');
write('launcher.ts', 'a\n');
git('add', '-A');
const baseline = hashInputs(root).hash;
const unchanged = (why: string) => assert.equal(hashInputs(root).hash, baseline, why);
const changed = (why: string) => assert.notEqual(hashInputs(root).hash, baseline, why);

await check('a version bump leaves the hash alone, and any other package.json change changes it', () => {
	write('package.json', manifest('2.0.0'));
	unchanged('the version counted');
	write('package.json', manifest('2.0.0', 'Another description.'));
	changed('the description did not count');
	write('package.json', manifest('1.0.0'));
	unchanged('the hash did not return');
});

await check('a change in src/ or launcher.ts leaves the hash alone', () => {
	write('src/extension.ts', 'b\n');
	write('launcher.ts', 'b\n');
	unchanged('src or the launcher counted');
});

await check('a change in the screenshot script, its fixture or the preview changes the hash', () => {
	for (const [path, original] of Object.entries({ 'scripts/generate-screenshots.ts': 'generate\n', 'scripts/screenshot-fixture/readme.md': 'fixture\n', 'scripts/social-preview.html': '<p>preview</p>\n' })) {
		write(path, 'edited\n');
		changed(`${path} did not count`);
		write(path, original);
	}
	unchanged('the hash did not return');
});

await check('an untracked file counts only once it is tracked', () => {
	write('scripts/screenshot-fixture/backup~', 'x');
	unchanged('an untracked file counted');
	git('add', 'scripts/screenshot-fixture/backup~');
	changed('a tracked file did not count');
});

await check('line endings do not change the hash', () => {
	git('rm', '-q', '--cached', 'scripts/screenshot-fixture/backup~');
	rmSync(join(root, 'scripts/screenshot-fixture/backup~'));
	unchanged('the hash did not return');
	write('scripts/social-preview.html', '<p>preview</p>\r\n');
	unchanged('CRLF counted');
});

rmSync(root, { recursive: true, force: true });
finish();
