// Gives Claude Code the page in front in VS Code's integrated browser, as webviewSelection.ts does
// for the Markdown Editor and SemanticDiff: the page as an opened file in the selection chip, and
// the text selected on it as a selection. A page is not an extension webview, so nothing runs in
// it. While a shared page is in front, this polls its selected text through VS Code's browser tools,
// as the tools Claude gets do. Only pages shared with the agent are read.
//
// The chip shows the page's title as its file name, and the selection's line numbers count the
// lines of the selected text, since a page has no source lines.

import * as vscode from 'vscode';
import { autoApprove, pageSelection, sharedPages, type SharedPage } from './browserPages.ts';
import { delivered, deliverToChip, reporter, type ChipSelection, type Delivered } from './webviewSelection.ts';

const POLL_MS = 500;
/** A read that takes longer waits on a confirmation dialog that auto-approve did not skip. */
const READ_MS = 3000;
const reportOnce = reporter('Browser page selection');
/** Tells the chip's delivered selections of this module from other modules'. */
const source = {};

const selectedKey = (pageId: string, text: string): string => `selected:${pageId}:${text}`;

/** Whether a page's selected text is in Claude Code's chip now. */
export const browserSelectionDelivered = (pageId: string, text: string): Delivered => delivered(source, selectedKey(pageId, text));

/** The page's title as the chip's file name; a slash would leave the chip with the last part only. */
const nameOf = (page: SharedPage): string => page.title.replace(/[\\/]+/g, '-').trim() || 'Browser page';

function chipSelection(page: SharedPage, text: string): ChipSelection {
	const base = { filePath: nameOf(page), sourceUri: page.url, startLine: 1 };
	return text ? { ...base, endLine: text.split(/\r?\n/).length, selectedText: text } : { ...base, endLine: 1 };
}

/** Starts following the shared page in front; dispose to stop. */
export function installBrowserSelection(): vscode.Disposable {
	let disposed = false;
	let busy = false;
	/** Off once a read waited on a dialog; the page still reaches the chip as an opened file. */
	let reading = true;
	let lastKey: string | undefined;

	async function check(): Promise<void> {
		if (busy || disposed) {
			return;
		}
		busy = true;
		const cancel = new vscode.CancellationTokenSource();
		try {
			const page = (await sharedPages(cancel.token))?.find(p => p.visibility === 'active');
			if (!page) {
				lastKey = undefined; // Another editor may have taken the chip meanwhile.
				return;
			}
			let text = '';
			if (reading && autoApprove()) {
				const read = new vscode.CancellationTokenSource();
				const timer = setTimeout(() => read.cancel(), READ_MS);
				try {
					text = await pageSelection(page.id, read.token) ?? '';
				} catch (err) {
					if (read.token.isCancellationRequested) {
						reading = false;
						reportOnce('dialog', 'reading a page\'s selection waited on a confirmation dialog, so selections on pages are not read; add "enable-proposed-api" for this extension to argv.json, as the README says.');
					} else {
						reportOnce('read', `reading a page's selection failed: ${err instanceof Error ? err.message : String(err)}`);
					}
				} finally {
					clearTimeout(timer);
					read.dispose();
				}
			}
			const key = text ? selectedKey(page.id, text) : `open:${page.id}:${page.title}:${page.url}`;
			if (key !== lastKey) {
				lastKey = key;
				await deliverToChip(source, key, chipSelection(page, text), () => lastKey === key);
			}
		} catch (err) {
			reportOnce('poll', `following the page in front failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			cancel.dispose();
			busy = false;
		}
	}

	const timer = setInterval(() => void check(), POLL_MS);
	timer.unref();
	const resend = () => {
		lastKey = undefined;
		void check();
	};
	const subscriptions = [vscode.window.tabGroups.onDidChangeTabs(resend), vscode.window.tabGroups.onDidChangeTabGroups(resend)];
	return {
		dispose() {
			disposed = true;
			clearInterval(timer);
			subscriptions.forEach(s => s.dispose());
		},
	};
}
