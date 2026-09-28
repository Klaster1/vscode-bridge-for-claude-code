// Shared by the extension, the stdio launcher and the prompt hook: where a VS Code window
// advertises its bridge, and how a Claude Code session finds the window whose
// first workspace folder is its working directory (or an ancestor of it).
// Imports nothing from 'vscode', so the launcher and hook can load it in plain Node.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** What a window writes to its discovery file, and what the launcher reads. */
export interface DiscoveryRecord {
	/** Named pipe (Windows) or socket path (elsewhere) the window listens on. */
	pipe: string;
	/** Secret the launcher must send as the first line of the connection. */
	token: string;
	/** The folder this record is keyed on, as the window saw it. */
	folder: string;
	/** Extension host process ID, for diagnostics only. */
	pid: number;
}

/**
 * Directory holding one discovery file per window. It sits under the user's
 * profile, which only that user (and administrators) can read, and that is
 * what keeps the pipe name and token private. VSCODE_TOOLS_BRIDGE_DIR moves
 * it, which the isolated test instance uses.
 */
export function discoveryDir(): string {
	const override = process.env['VSCODE_TOOLS_BRIDGE_DIR'];
	if (override) {
		return override;
	}
	const base = process.platform === 'win32'
		? (process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'))
		: join(homedir(), '.cache');
	return join(base, 'vscode-tools-bridge');
}

/**
 * Folder path as a stable key: resolved, junctions and symlinks followed, and
 * lower-cased on Windows, where VS Code and a shell can disagree on the case of
 * the drive letter.
 */
export function folderKey(folder: string): string {
	let path = resolve(folder);
	try {
		path = realpathSync.native(path);
	} catch {
		// A missing folder keeps its resolved path; the lookup then just fails.
	}
	path = path.replace(/[\\/]+$/, '');
	return process.platform === 'win32' ? path.toLowerCase() : path;
}

export function folderHash(folder: string): string {
	return createHash('sha256').update(folderKey(folder)).digest('hex').slice(0, 16);
}

export function discoveryFile(folder: string): string {
	return join(discoveryDir(), `${folderHash(folder)}.json`);
}

/**
 * The record of the window registered under `start` or its nearest ancestor
 * that has one, so a session started in a subfolder still finds its window.
 */
export function findRecord(start: string): DiscoveryRecord | undefined {
	for (let dir = resolve(start); ; dir = dirname(dir)) {
		const file = discoveryFile(dir);
		if (existsSync(file)) {
			return JSON.parse(readFileSync(file, 'utf8')) as DiscoveryRecord;
		}
		if (dirname(dir) === dir) {
			return undefined;
		}
	}
}
