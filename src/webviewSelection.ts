// Gives Claude Code the selection in editors that VS Code shows in a webview, which Claude Code's
// IDE context does not report: VS Code's Markdown Editor (markdownSelection.ts) and SemanticDiff's
// diff panel (semanticDiffSelection.ts). VS Code has no API for either selection, so this patches
// the `html` setter that every extension's webviews share. A page handler recognises its page and
// inserts a script that posts the selection to this extension.
//
// The same prototype's `postMessage` is wrapped to find Claude Code's chat webviews, which Claude
// Code feeds with `selection_changed` messages for its selection chip. A selection goes to them in
// that format. The format is Claude Code's internal one and can change with its updates.
//
// The Claude Code CLI, connected to VS Code with /ide, gets text editors' selections from the
// listeners Claude Code registers with window.onDidChangeTextEditorSelection. That method is
// wrapped on the same API object to collect those listeners, and a webview's selection is passed
// to them as if a text editor had changed it. The wrapper must be in place before Claude Code
// subscribes, so the extension activates at startup.
//
// Whatever the patch relies on and cannot find is logged once, and the part that needs it stays
// off. No error reaches the extension that owns the page.

import * as vscode from 'vscode';
import { claudeCodeApi } from './claudeApi.ts';

/** One kind of page whose selection the patch reads. */
export interface PageHandler {
	matches(html: string): boolean;
	/** Returns the HTML to set, with the handler's script inserted. */
	patch(webview: vscode.Webview, html: string): string;
	/** Sees each message an extension posts to a webview. */
	posted?(webview: vscode.Webview, message: unknown): void;
	/** Runs when the tabs or tab groups change; `closed` says a tab was closed. */
	tabsChanged(closed: boolean): void;
	/** Forgets the handler's pages when the patch is removed. */
	clear(): void;
}

/** A selection in a document, as Claude Code gets one from a text editor. */
export interface Delivery {
	doc: vscode.TextDocument;
	selection: vscode.Selection;
	/** The selected text, when the page shows other text than the document holds in the range. */
	text?: string;
}

/** Where a selection has reached Claude Code: its chat panel's chip, and the CLI connected through /ide. */
export interface Delivered { chip: boolean; cli: boolean }

/** Claude Code's selection payload, as it builds one for a text editor. */
interface ChipSelection {
	filePath: string;
	sourceUri: string;
	startLine: number;
	endLine: number;
	startColumn?: number;
	endColumn?: number;
	selectedText?: string;
}

/** A delivered selection: the page record it came from and the handler's key for it. */
type Mark = { source: object; key: string };

const reported = new Set<string>();
/** Claude Code's chat webviews, found by the messages the extension posts to them. */
const claudeWebviews = new Set<vscode.Webview>();
/** The selection behind the chip; cleared when a text editor takes the chip over. */
let chip: Mark | undefined;
/** The listeners Claude Code registered for text editor selections; the CLI's selection comes from them. */
const selectionListeners = new Set<(event: vscode.TextEditorSelectionChangeEvent) => unknown>();
/** The selection the CLI last got; cleared when a text editor's selection changes. */
let cli: Mark | undefined;
let postToWebview: ((webview: vscode.Webview, message: unknown) => Thenable<boolean>) | undefined;
let running = false;
let log: (message: string) => void = () => undefined;

/** Logs each key once, with the prefix that names the part of the patch. */
export const reporter = (prefix: string) => (key: string, message: string): void => {
	if (!reported.has(`${prefix}\0${key}`)) {
		reported.add(`${prefix}\0${key}`);
		log(`${prefix}: ${message}`);
	}
};

const reportOnce = reporter('Webview selection');

export const delivered = (source: object, key: string): Delivered => ({
	chip: chip?.source === source && chip.key === key,
	cli: cli?.source === source && cli.key === key,
});

/** Gives the selection to Claude Code's selection listeners, as if a text editor had changed it, for the CLI. */
function feedListeners(mark: Mark, { doc, selection }: Delivery, isCurrent: () => boolean): void {
	if (!selectionListeners.size) {
		reportOnce('cli', 'no Claude Code selection listener found, so the CLI gets no selection; Claude Code may have subscribed before the bridge started, and the prompt hook note carries the selection.');
		return;
	}
	const event = { textEditor: { document: doc, selection, selections: [selection] }, selections: [selection], kind: undefined };
	let fed = false;
	for (const listener of [...selectionListeners]) {
		try {
			Promise.resolve(listener(event as unknown as vscode.TextEditorSelectionChangeEvent)).catch(err => reportOnce('listener', `a Claude Code listener failed: ${err instanceof Error ? err.message : String(err)}`));
			fed = true;
		} catch (err) {
			reportOnce('listener', `a Claude Code listener failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	if (fed && isCurrent()) {
		cli = mark;
	}
}

/**
 * Gives a selection to Claude Code: the CLI through its listeners, and its chat panel's chip by
 * posting to every webview as Claude Code does. `read` resolves undefined when a newer selection
 * has replaced this one.
 */
export async function deliver(source: object, key: string, read: () => Promise<Delivery | undefined>, isCurrent: () => boolean): Promise<void> {
	try {
		const delivery = await read();
		if (!delivery) {
			return;
		}
		const { doc, selection, text } = delivery;
		feedListeners({ source, key }, delivery, isCurrent);
		if (!postToWebview) {
			return;
		}
		const range = new vscode.Range(selection.start, selection.end);
		const base = { filePath: doc.fileName, sourceUri: doc.uri.toString(), startLine: range.start.line + 1 };
		let payload: ChipSelection | undefined;
		if (!range.isEmpty) {
			payload = { ...base, endLine: range.end.line + 1, startColumn: range.start.character, endColumn: range.end.character, selectedText: text ?? doc.getText(range) };
		} else if (vscode.workspace.getConfiguration('claudeCode').get<boolean>('attachOpenFile') ?? true) {
			payload = { ...base, endLine: base.startLine }; // With the setting off, Claude Code keeps no chip for a cursor.
		}
		const targets = [...claudeWebviews];
		if (!targets.length) {
			reportOnce('chip', 'no Claude Code webview found yet; the prompt hook note carries the selection.');
			return;
		}
		const message = { type: 'from-extension', message: { type: 'request', channelId: '', requestId: '', request: { type: 'selection_changed', selection: payload } } };
		const posted = await Promise.all(targets.map(async webview => {
			try {
				if (await postToWebview!(webview, message)) {
					return true;
				}
			} catch {
				// Dropped below.
			}
			claudeWebviews.delete(webview);
			return false;
		}));
		if (posted.some(Boolean) && isCurrent()) {
			chip = { source, key };
		}
	} catch (err) {
		reportOnce('chip', `posting the selection to Claude Code failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/** Claude Code posts `{ type: 'from-extension', message: { type, ... } }` to its chat webviews. */
function isClaudeMessage(message: unknown): boolean {
	const inner = (message as { type?: unknown; message?: { type?: unknown } } | null)?.message;
	return (message as { type?: unknown } | null)?.type === 'from-extension' && typeof inner === 'object' && typeof inner?.type === 'string';
}

function findOwner(start: object | null, name: string): { owner: object; descriptor: PropertyDescriptor } | undefined {
	for (let owner = start; owner; owner = Object.getPrototypeOf(owner)) {
		const descriptor = Object.getOwnPropertyDescriptor(owner, name);
		if (descriptor) {
			return { owner, descriptor };
		}
	}
	return undefined;
}

/**
 * Starts reading the selections of the handlers' pages; dispose to restore the `html` setter and
 * `postMessage`. A webview shows the patched page for as long as it lives.
 */
export function installWebviewSelection(report: (message: string) => void, handlers: PageHandler[]): vscode.Disposable {
	log = report;
	// Every extension's webviews share one prototype, so a throwaway panel gives access to the setter the other extensions use. It opens in the active group: a new group would stay behind when workbench.editor.closeEmptyGroups is off.
	const panel = vscode.window.createWebviewPanel('vscodeBridge.probe', 'VS Code Bridge for Claude Code', { viewColumn: vscode.ViewColumn.Active, preserveFocus: true }, {});
	const prototype: object | null = Object.getPrototypeOf(panel.webview);
	panel.dispose();
	const html = findOwner(prototype, 'html');
	const originalSet = html?.descriptor.set;
	if (!html || !originalSet || !html.descriptor.configurable) {
		reportOnce('setter', 'the webview has no configurable html setter; no selection is read.');
		return { dispose: () => undefined };
	}
	const { owner, descriptor } = html;
	let active = true;
	const patched: PropertyDescriptor = {
		...descriptor,
		set(this: vscode.Webview, value: unknown) {
			let page = value;
			if (active && typeof value === 'string') {
				try {
					const handler = handlers.find(h => h.matches(value));
					page = handler ? handler.patch(this, value) : value;
				} catch (err) {
					reportOnce('patch', `patching the page failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			originalSet.call(this, page);
		},
	};
	Object.defineProperty(owner, 'html', patched);
	running = true;

	const post = findOwner(prototype, 'postMessage');
	const originalPost = post?.descriptor.value as ((this: vscode.Webview, message: unknown) => Thenable<boolean>) | undefined;
	let patchedPost: PropertyDescriptor | undefined;
	if (post && typeof originalPost === 'function' && post.descriptor.configurable && post.descriptor.writable) {
		postToWebview = (webview, message) => originalPost.call(webview, message);
		patchedPost = {
			...post.descriptor,
			value(this: vscode.Webview, message: unknown) {
				let result: Thenable<boolean>;
				try {
					result = originalPost.call(this, message);
				} catch (err) {
					claudeWebviews.delete(this);
					throw err;
				}
				if (active && isClaudeMessage(message)) {
					claudeWebviews.add(this);
					// A webview that is not live resolves false; it is added again by its next message.
					Promise.resolve(result).then(delivered => delivered === false && claudeWebviews.delete(this), () => claudeWebviews.delete(this));
				}
				if (active) {
					for (const handler of handlers) {
						try {
							handler.posted?.(this, message);
						} catch (err) {
							reportOnce('posted', `reading a message to a webview failed: ${err instanceof Error ? err.message : String(err)}`);
						}
					}
				}
				return result;
			},
		};
		Object.defineProperty(post.owner, 'postMessage', patchedPost);
	} else {
		reportOnce('postMessage', 'the webview has no writable postMessage method; Claude Code\'s selection chip is not fed.');
	}

	// Collects the selection listeners Claude Code registers from here on; registration still goes through the original.
	const claude = claudeCodeApi();
	const claudeWindow = typeof claude === 'string' ? undefined : claude.window;
	const listenDescriptor = claudeWindow && Object.getOwnPropertyDescriptor(claudeWindow, 'onDidChangeTextEditorSelection');
	let restoreListen: (() => void) | undefined;
	if (claudeWindow && listenDescriptor && typeof listenDescriptor.value === 'function' && listenDescriptor.writable && listenDescriptor.configurable) {
		const originalListen = listenDescriptor.value as (listener: (e: vscode.TextEditorSelectionChangeEvent) => unknown, thisArgs?: unknown) => vscode.Disposable;
		const patchedListen: PropertyDescriptor = {
			...listenDescriptor,
			value(this: unknown, listener: (e: vscode.TextEditorSelectionChangeEvent) => unknown, thisArgs?: unknown, subscriptions?: vscode.Disposable[]) {
				if (typeof listener !== 'function') {
					return originalListen.apply(this, arguments as never);
				}
				const bound = thisArgs === undefined ? listener : listener.bind(thisArgs);
				const subscription = originalListen.call(this, listener, thisArgs);
				if (active) {
					selectionListeners.add(bound);
				}
				const wrapped = new vscode.Disposable(() => {
					selectionListeners.delete(bound);
					subscription.dispose();
				});
				subscriptions?.push(wrapped);
				return wrapped;
			},
		};
		Object.defineProperty(claudeWindow, 'onDidChangeTextEditorSelection', patchedListen);
		restoreListen = () => {
			// Another extension may have wrapped it since; leave its wrapper in place.
			if (Object.getOwnPropertyDescriptor(claudeWindow, 'onDidChangeTextEditorSelection')?.value === patchedListen.value) {
				Object.defineProperty(claudeWindow, 'onDidChangeTextEditorSelection', listenDescriptor);
			}
		};
	} else {
		reportOnce('listen', `could not wrap onDidChangeTextEditorSelection on Claude Code's API object (${typeof claude === 'string' ? claude : 'not replaceable'}); the CLI gets no selection.`);
	}

	const tabsChanged = (closed: boolean) => {
		for (const handler of handlers) {
			try {
				handler.tabsChanged(closed);
			} catch (err) {
				reportOnce('tabs', `following the tabs failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	};
	const disposables = [
		// Claude Code replaces the chip with a text editor's selection on these events.
		vscode.window.onDidChangeActiveTextEditor(editor => { chip = editor ? undefined : chip; }),
		vscode.window.onDidChangeTextEditorSelection(e => {
			chip = e.textEditor === vscode.window.activeTextEditor ? undefined : chip;
			cli = undefined; // The CLI's listener takes every text editor's selection.
		}),
		vscode.window.tabGroups.onDidChangeTabs(e => tabsChanged(e.closed.length > 0)),
		vscode.window.tabGroups.onDidChangeTabGroups(() => tabsChanged(false)),
	];
	return {
		dispose() {
			active = false;
			running = false;
			disposables.forEach(d => d.dispose());
			handlers.forEach(h => h.clear());
			claudeWebviews.clear();
			selectionListeners.clear();
			chip = undefined;
			cli = undefined;
			postToWebview = undefined;
			// Another extension may have wrapped a method since; leave its wrapper in place, which now passes calls through.
			if (Object.getOwnPropertyDescriptor(owner, 'html')?.set === patched.set) {
				Object.defineProperty(owner, 'html', descriptor);
			}
			restoreListen?.();
			if (post && patchedPost && Object.getOwnPropertyDescriptor(post.owner, 'postMessage')?.value === patchedPost.value) {
				Object.defineProperty(post.owner, 'postMessage', post.descriptor);
			}
		},
	};
}

/** Whether the patch is installed; without it no selection is read. */
export const webviewSelectionRunning = (): boolean => running;
