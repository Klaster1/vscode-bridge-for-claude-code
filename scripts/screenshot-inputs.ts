// The files that shape the README screenshots and the social preview, hashed so a check can
// tell, offline, whether the committed images are older than their inputs. Shared by
// generate-screenshots.ts, which records the hash, and check-screenshots.ts, which compares it.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Repo-relative files and folders whose contents the images depend on. */
export const inputPaths = [
	'src', // The extension: its tools, settings handling, selection and chat-link patches.
	'package.json', // The settings the Settings shot lists, and the activation events.
	'launcher.ts', // What /mcp starts to reach the window.
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

const listFiles = (root: string, path: string): string[] => {
	const full = join(root, path);
	if (!existsSync(full)) {
		return [];
	}
	if (!statSync(full).isDirectory()) {
		return [path];
	}
	return readdirSync(full).flatMap(name => listFiles(root, `${path}/${name}`));
};

/** Hashes the inputs with line endings as LF, so Windows and Linux checkouts agree. */
export function hashInputs(root: string): Pick<InputRecord, 'hash' | 'files'> {
	const files: Record<string, string> = {};
	const all = createHash('sha256');
	for (const path of inputPaths.flatMap(p => listFiles(root, p)).map(p => relative(root, join(root, p)).replaceAll('\\', '/')).sort()) {
		const contents = Buffer.from(readFileSync(join(root, path)).toString('latin1').replaceAll('\r\n', '\n'), 'latin1');
		files[path] = createHash('sha256').update(contents).digest('hex');
		all.update(`${path}\0${files[path]}\n`);
	}
	return { hash: all.digest('hex'), files };
}
