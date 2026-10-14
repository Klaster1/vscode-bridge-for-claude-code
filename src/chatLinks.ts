// Makes the file links in Claude Code's chat open in the editor that VS Code's
// editor associations and custom editors choose, such as the Markdown Editor
// for `.md` (anthropics/claude-code#81482).
//
// Claude Code opens a link with window.showTextDocument(uri), which forces the
// text editor. Only when that rejects does it fall back to the `vscode.open`
// command, which honours associations. So this wraps showTextDocument on the
// `vscode` API object that Claude Code holds, and rejects a file URI that
// should open in another editor. The rejection triggers Claude Code's own
// fallback. Every other call passes through unchanged.
//
// A missing Claude Code, API object or replaceable showTextDocument is logged
// once, and nothing is patched.

import * as vscode from 'vscode';
import { claudeCodeApi, claudeCodeId } from './claudeApi.ts';
import { globMatches } from './glob.ts';

const reported = new Set<string>();

function reportOnce(report: (message: string) => void, key: string, message: string): void {
	if (!reported.has(key)) {
		reported.add(key);
		report(`Chat links: ${message}`);
	}
}

/** Matches as VS Code does: a pattern with a slash against the whole path, any other against the file name. */
function patternMatches(pattern: string, uri: vscode.Uri): boolean {
	return globMatches(pattern, pattern.includes('/') ? `${uri.scheme}:${uri.path}` : uri.path.slice(uri.path.lastIndexOf('/') + 1));
}

/** Whether VS Code opens this file in an editor other than the text editor. */
function opensInOtherEditor(uri: vscode.Uri): boolean {
	const setting = vscode.workspace.getConfiguration('workbench').inspect<Record<string, string>>('editorAssociations');
	const associations = Object.entries({ ...setting?.defaultValue, ...setting?.globalValue, ...setting?.workspaceValue })
		.filter(([pattern, viewType]) => typeof viewType === 'string' && patternMatches(pattern, uri))
		.sort(([a], [b]) => b.length - a.length); // The longest pattern wins, as in VS Code.
	if (associations[0]) {
		return associations[0][1] !== 'default';
	}
	return vscode.extensions.all.some(extension => {
		const editors = (extension.packageJSON as { contributes?: { customEditors?: { priority?: string; selector?: { filenamePattern?: string }[] }[] } } | undefined)?.contributes?.customEditors;
		return editors?.some(editor => editor.priority === 'default' && editor.selector?.some(s => s.filenamePattern && patternMatches(s.filenamePattern, uri)));
	});
}

export function installChatLinks(report: (message: string) => void): vscode.Disposable {
	const nothing = { dispose: () => undefined };
	const api = claudeCodeApi();
	if (typeof api === 'string') {
		reportOnce(report, 'missing', `${api}; its links keep opening in the text editor.`);
		return nothing;
	}
	const window = api.window;
	const descriptor = Object.getOwnPropertyDescriptor(window, 'showTextDocument');
	if (!descriptor || typeof descriptor.value !== 'function' || !descriptor.writable || !descriptor.configurable) {
		reportOnce(report, 'api', `could not get a replaceable showTextDocument from ${claudeCodeId}'s API object; its links keep opening in the text editor.`);
		return nothing;
	}
	const original = descriptor.value as (...args: unknown[]) => unknown;
	let active = true;
	const patched: PropertyDescriptor = {
		...descriptor,
		value(this: unknown, ...args: unknown[]) {
			let reject = false;
			try {
				const target = args[0];
				reject = active && target instanceof vscode.Uri && target.scheme === 'file' && opensInOtherEditor(target);
			} catch (err) {
				reportOnce(report, 'check', `checking a link failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			// A rejected promise, not a throw: Claude Code chains .then on the result.
			return reject ? Promise.reject(new Error('This file opens in a custom editor; vscode-tools-bridge leaves it to vscode.open.')) : original.apply(this, args);
		},
	};
	Object.defineProperty(window, 'showTextDocument', patched);
	return {
		dispose() {
			active = false;
			// Another extension may have wrapped it since; leave its wrapper in place, which now passes calls through.
			if (Object.getOwnPropertyDescriptor(window, 'showTextDocument')?.value === patched.value) {
				Object.defineProperty(window, 'showTextDocument', descriptor);
			}
		},
	};
}
