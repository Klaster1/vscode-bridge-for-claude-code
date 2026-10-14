// Offline check of src/glob.ts against the patterns editor associations use.
//
//   node test/glob-check.ts

import { globMatches } from '../src/glob.ts';

const cases: [pattern: string, target: string, expected: boolean][] = [
	['*.md', 'README.md', true],
	['*.md', 'readme.MD', true],
	['*.md', 'notes.md.bak', false],
	['*.md', 'docs/a.md', false],
	['*.{png,jpg}', 'shot.JPG', true],
	['*.{png,jpg}', 'shot.gif', false],
	['?.ts', 'a.ts', true],
	['?.ts', 'ab.ts', false],
	['[ab].ts', 'b.ts', true],
	['[!ab].ts', 'b.ts', false],
	['**/docs/*.md', 'file:/c:/work/docs/a.md', true],
	['**/docs/*.md', 'file:/c:/work/docs/sub/a.md', false],
	['**/docs/**', 'file:/c:/work/docs/sub/a.md', true],
	['**/*.md', 'file:/c:/a.md', true],
	['a.b', 'axb', false],
	['{a,b', 'a', false],
];
let failed = 0;
for (const [pattern, target, expected] of cases) {
	const actual = globMatches(pattern, target);
	if (actual !== expected) {
		failed++;
		console.log(`FAIL  ${pattern} vs ${target}: expected ${expected}, got ${actual}`);
	}
}
console.log(failed ? `${failed} glob check(s) failed` : `PASS  glob checks (${cases.length})`);
process.exit(failed ? 1 : 0);
