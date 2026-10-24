// Gives Claude Code the image in front in VS Code's image preview as an opened file in its
// selection chip, as webviewSelection.ts does for the Markdown Editor. Claude Code follows the
// active text editor, and an image preview is a custom editor, so it shows no chip for one.
// Nothing is selected in an image; the CLI gets nothing from this, and the prompt hook names the image.

import * as vscode from 'vscode';
import { clearChip, deliverToChip, reporter } from './webviewSelection.ts';

/** The image types Claude Code's Read tool shows as images. */
export const imageFile = /\.(png|jpe?g|gif|webp)$/i;

/** Claude Code clears its chip in its handler of this event, and the handlers run in no set order; the image goes again after them. */
const AFTER_CLAUDE_CODE_MS = 150;
const reportOnce = reporter('Image chip');
/** Tells the chip's delivered selections of this module from other modules'. */
const source = {};

/** The image file of a tab, when it shows one. */
export function imageOf(tab: vscode.Tab | undefined): vscode.Uri | undefined {
	const input = tab?.input;
	const uri = input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText ? input.uri : undefined;
	return uri?.scheme === 'file' && imageFile.test(uri.path) ? uri : undefined;
}

/** Starts following the image in front of the active editor group; dispose to stop. */
export function installImageSelection(): vscode.Disposable {
	let lastKey: string | undefined;
	let timer: NodeJS.Timeout | undefined;

	function check(): void {
		const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
		const uri = imageOf(tab);
		if (!uri) {
			// A text editor in front puts its own selection on the chip. With none, the image would stay on it.
			if (lastKey && !(tab?.input instanceof vscode.TabInputText || tab?.input instanceof vscode.TabInputTextDiff)) {
				void clearChip(source);
			}
			lastKey = undefined; // The image goes again when it is back in front.
			return;
		}
		const key = `image:${uri.toString()}`;
		if (key === lastKey) {
			return;
		}
		lastKey = key;
		deliverToChip(source, key, { filePath: uri.fsPath, sourceUri: uri.toString(), startLine: 1, endLine: 1 }, () => lastKey === key)
			.catch((err: unknown) => reportOnce('chip', `posting the image failed: ${err instanceof Error ? err.message : String(err)}`));
	}

	check();
	const subscriptions = [
		vscode.window.tabGroups.onDidChangeTabs(check),
		vscode.window.tabGroups.onDidChangeTabGroups(check),
		vscode.window.onDidChangeActiveTextEditor(editor => {
			if (!editor) {
				clearTimeout(timer);
				timer = setTimeout(() => {
					lastKey = undefined;
					check();
				}, AFTER_CLAUDE_CODE_MS);
			}
		}),
	];
	return {
		dispose() {
			clearTimeout(timer);
			subscriptions.forEach(s => s.dispose());
		},
	};
}
