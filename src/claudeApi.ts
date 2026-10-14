// Finds the `vscode` API object that Claude Code's extension holds. The
// extension host caches one API object per extension and picks it by the path
// of the requiring file, so requiring 'vscode' as a file of Claude Code's
// extension returns the object Claude Code uses.

import * as vscode from 'vscode';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export const claudeCodeId = 'anthropic.claude-code';

/** The API object, or the reason there is none. */
export function claudeCodeApi(): typeof vscode | string {
	const claude = vscode.extensions.getExtension(claudeCodeId);
	if (!claude) {
		return `${claudeCodeId} is not installed`;
	}
	const api = createRequire(join(claude.extensionPath, 'extension.js'))('vscode') as typeof vscode | undefined;
	return api && api !== vscode && api.window ? api : `${claudeCodeId}'s API object was not found`;
}
