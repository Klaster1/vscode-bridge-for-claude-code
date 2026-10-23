// Finds the `vscode` API object that another extension holds. The extension host caches one API
// object per extension and picks it by the path of the requiring file, so requiring 'vscode' as
// a file of that extension's folder (one that exists) returns the object the extension uses, even
// before it activates.

import * as vscode from 'vscode';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export const claudeCodeId = 'anthropic.claude-code';

/** The API object, or the reason there is none. */
export function extensionApi(id: string): typeof vscode | string {
	const extension = vscode.extensions.getExtension(id);
	if (!extension) {
		return `${id} is not installed`;
	}
	let api: typeof vscode | undefined;
	try {
		api = createRequire(join(extension.extensionPath, 'package.json'))('vscode') as typeof vscode | undefined;
	} catch (err) {
		return `${id}'s API object could not be required: ${err instanceof Error ? err.message : String(err)}`;
	}
	return api && api !== vscode && api.window ? api : `${id}'s API object was not found`;
}

export const claudeCodeApi = (): typeof vscode | string => extensionApi(claudeCodeId);
