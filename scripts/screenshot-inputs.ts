// The files that shape the README screenshots and the social preview, hashed so a check can
// tell, offline, whether the committed images are older than their inputs. Shared by
// generate-screenshots.ts, which records the hash, and check-screenshots.ts, which compares it.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Repo-relative files and folders whose contents the images depend on. Only git-tracked files count. */
const inputPaths = [
	'package.json', // The settings the Settings shot lists, the name and the description. Its version does not count.
	'scripts/generate-screenshots.ts',
	'scripts/screenshot-inputs.ts', // Changes what counts as an input.
	'scripts/screenshot-fixture',
	'scripts/social-preview.html',
];

export const recordFile = 'docs/screenshots/inputs.json';

export interface InputRecord {
	/** SHA-256 over every input's path and contents. */
	hash: string;
	/** SHA-256 of each input, to name the ones that changed. */
	files: Record<string, string>;
	/** Images the run wrote, repo-relative. */
	images: string[];
	/** Recorded for the reader only: these come from the machine that ran the script, not the repo. */
	vscode: string;
	claudeCode: string;
}

/** The tracked inputs. An untracked file, such as an editor backup, is in no one else's checkout, so it must not count. */
const listFiles = (root: string): string[] =>
	execFileSync('git', ['ls-files', '-z', '--', ...inputPaths], { cwd: root, encoding: 'utf8' })
		.split('\0')
		.filter(path => path && existsSync(join(root, path)));

/** package.json minus its version, so a release does not make the screenshots stale. */
const withoutVersion = (json: string): string => {
	const { version: _version, ...rest } = JSON.parse(json) as { version?: string };
	return JSON.stringify(rest, null, 2);
};

/** Hashes the inputs with line endings as LF, so Windows and Linux checkouts agree. */
export function hashInputs(root: string): Pick<InputRecord, 'hash' | 'files'> {
	const files: Record<string, string> = {};
	const all = createHash('sha256');
	for (const path of listFiles(root).sort()) {
		const text = readFileSync(join(root, path)).toString('latin1').replaceAll('\r\n', '\n');
		const contents = Buffer.from(path === 'package.json' ? withoutVersion(text) : text, 'latin1');
		files[path] = createHash('sha256').update(contents).digest('hex');
		all.update(`${path}\0${files[path]}\n`);
	}
	return { hash: all.digest('hex'), files };
}
