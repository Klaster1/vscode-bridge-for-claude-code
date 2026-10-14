// Offline check of CHANGELOG.md: version headings in descending order, the top one equal to
// package.json's version, and sections of one-line bullets of at most 100 characters.
//
//   node test/changelog-check.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BULLET = 100; // Characters after "- ", Markdown included.
const sections = new Set(['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security']);

const root = join(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
const lines = readFileSync(join(root, 'CHANGELOG.md'), 'utf8').split(/\r?\n/);

const errors: string[] = [];
const versions: { line: number; parts: number[]; date: string }[] = [];
let section: { name: string; line: number; bullets: number } | undefined;
let versionSections = 0;
const closeSection = () => {
	if (section && section.bullets === 0) {
		errors.push(`line ${section.line}: "### ${section.name}" has no bullets`);
	}
	section = undefined;
};
const closeVersion = () => {
	closeSection();
	const last = versions.at(-1);
	if (last && versionSections === 0) {
		errors.push(`line ${last.line}: the version has no sections`);
	}
	versionSections = 0;
};

lines.forEach((text, i) => {
	const line = i + 1;
	if (text.startsWith('## ')) {
		closeVersion();
		const m = /^## \[(\d+)\.(\d+)\.(\d+)\] - (\d{4}-\d{2}-\d{2})$/.exec(text);
		if (!m || Number.isNaN(Date.parse(m[4]!))) {
			errors.push(`line ${line}: a version heading reads "## [x.y.z] - YYYY-MM-DD", not "${text}"`);
			return;
		}
		versions.push({ line, parts: [Number(m[1]), Number(m[2]), Number(m[3])], date: m[4]! });
	} else if (versions.length === 0) {
		return; // The title and any intro above the first version.
	} else if (text.startsWith('### ')) {
		closeSection();
		const name = text.slice(4);
		if (!sections.has(name)) {
			errors.push(`line ${line}: "${name}" is not one of ${[...sections].join(', ')}`);
		}
		section = { name, line, bullets: 0 };
		versionSections++;
	} else if (text.startsWith('- ')) {
		if (!section) {
			errors.push(`line ${line}: a bullet outside a "###" section`);
			return;
		}
		section.bullets++;
		const length = [...text.slice(2)].length;
		if (length > MAX_BULLET) {
			errors.push(`line ${line}: the bullet has ${length} characters, over the limit of ${MAX_BULLET}`);
		}
	} else if (text.trim() !== '') {
		errors.push(`line ${line}: only one-line "- " bullets go under a section, not "${text}"`);
	}
});
closeVersion();

const compare = (a: number[], b: number[]): number => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
if (versions.length === 0) {
	errors.push('no version heading');
} else if (versions[0]!.parts.join('.') !== version) {
	errors.push(`the top version is ${versions[0]!.parts.join('.')}, but package.json has ${version}`);
}
for (let i = 1; i < versions.length; i++) {
	const [newer, older] = [versions[i - 1]!, versions[i]!];
	if (compare(newer.parts, older.parts) <= 0 || newer.date < older.date) {
		errors.push(`line ${older.line}: versions go from newest to oldest, by number and date`);
	}
}

for (const e of errors) {
	console.log(`FAIL  CHANGELOG.md ${e}`);
}
if (errors.length) {
	process.exit(1);
}
console.log(`PASS  CHANGELOG.md: ${versions.length} version(s), top ${version}`);
