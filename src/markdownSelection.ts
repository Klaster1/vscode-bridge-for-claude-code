// Reads the selection in VS Code's rich Markdown Editor (the custom editor
// vscode.markdown.editor). VS Code has no API for it, so this patches the `html`
// setter that every extension's webviews share. For the Markdown Editor's page
// it inserts one script, which wraps acquireVsCodeApi so that the editor's
// setState calls, made on every selection change, also post the selection's
// offsets into the Markdown source to this extension. The script reads nothing
// else from the page.
//
// The same prototype's `postMessage` is wrapped to find Claude Code's chat
// webviews, which Claude Code feeds with `selection_changed` messages for its
// selection chip. The Markdown Editor's selection goes to them in that format.
// The format is Claude Code's internal one and can change with its updates.
//
// The Claude Code CLI, connected to VS Code with /ide, gets text editors'
// selections from the listeners Claude Code registers with
// window.onDidChangeTextEditorSelection. That method is wrapped on the same API
// object to collect those listeners, and a Markdown Editor's selection is
// passed to them as if a text editor had changed it. The wrapper must be in
// place before Claude Code subscribes, so the extension activates at startup.
//
// Whatever the patch relies on and cannot find (the setter, the page's meta
// tags, <head>, a message from the page) is logged once, and the patch then
// does nothing. No error reaches the Markdown extension.

import * as vscode from 'vscode';
import { claudeCodeApi } from './claudeApi.ts';

const viewType = 'vscode.markdown.editor';
const messageType = 'vscodeToolsBridge.markdownSelection';

/** Offsets into the Markdown source, in the order the user made the selection. */
interface Offsets { anchor: number; active: number }

interface Editor {
	webview: vscode.Webview;
	listener: vscode.Disposable;
	silence: NodeJS.Timeout;
	/** The document text when the page was built; matches the editor's document while it is unedited. */
	content: string | undefined;
	uri: vscode.Uri | undefined;
	selection: Offsets | undefined;
	/** Orders editors that show the same file: the newest one's selection wins. */
	updated: number;
}

export interface MarkdownEditorState {
	uri: vscode.Uri;
	active: boolean;
	/** Absent when the editor has not reported a selection. Lines are 1-based; an empty `text` means a cursor. */
	selection?: { startLine: number; endLine: number; text: string };
	/** Where the selection has reached Claude Code: its chat panel's chip, and the CLI connected through /ide. */
	delivered: { chip: boolean; cli: boolean };
}

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

const forwarder = `(() => {
	const acquire = globalThis.acquireVsCodeApi;
	if (typeof acquire !== 'function') { return; }
	globalThis.acquireVsCodeApi = function () {
		const api = acquire.apply(this, arguments);
		return Object.freeze({ ...api, setState(state) {
			try {
				const s = state && state.selection;
				api.postMessage({ type: '${messageType}', selection: s ? { anchor: s.anchor, active: s.active } : null });
			} catch { /* the editor's own setState must still run */ }
			return api.setState(state);
		} });
	};
})();`;

const editors = new Map<vscode.Webview, Editor>();
const reported = new Set<string>();
/** Claude Code's chat webviews, found by the messages the extension posts to them. */
const claudeWebviews = new Set<vscode.Webview>();
/** The editor and offsets behind the chip; cleared when a text editor takes the chip over. */
let chip: { editor: Editor; offsets: string } | undefined;
/** The listeners Claude Code registered for text editor selections; the CLI's selection comes from them. */
const selectionListeners = new Set<(event: vscode.TextEditorSelectionChangeEvent) => unknown>();
/** The editor and offsets the CLI last got; cleared when a text editor's selection changes. */
let cli: { editor: Editor; offsets: string } | undefined;
let postToWebview: ((webview: vscode.Webview, message: unknown) => Thenable<boolean>) | undefined;
let clock = 0;
let running = false;
let report: (message: string) => void = () => undefined;

function reportOnce(key: string, message: string): void {
	if (!reported.has(key)) {
		reported.add(key);
		report(`Markdown Editor selection: ${message}`);
	}
}

const markdownTabUris = (frontOnly: boolean): vscode.Uri[] =>
	vscode.window.tabGroups.all.flatMap(group => (frontOnly ? [group.activeTab] : group.tabs).flatMap(tab =>
		tab?.input instanceof vscode.TabInputCustom && tab.input.viewType === viewType ? [tab.input.uri] : []));

/** The only URI in the list, or undefined when it holds none or several. */
function single(uris: vscode.Uri[]): vscode.Uri | undefined {
	const distinct = new Map(uris.map(u => [u.toString(), u]));
	return distinct.size === 1 ? [...distinct.values()][0] : undefined;
}

/**
 * Finds the document behind an editor: the open Markdown document whose text
 * equals the page's initial content. When that is not unique, the editors in
 * front of their groups that no other record claims.
 */
function resolve(editor: Editor): vscode.Uri | undefined {
	if (editor.uri) {
		return editor.uri;
	}
	const open = new Set(markdownTabUris(false).map(u => u.toString()));
	const matching = editor.content === undefined ? [] : vscode.workspace.textDocuments
		.filter(d => open.has(d.uri.toString()) && d.getText() === editor.content).map(d => d.uri);
	editor.uri = single(matching);
	if (!editor.uri) {
		const claimed = new Set([...editors.values()].flatMap(e => e !== editor && e.uri ? [e.uri.toString()] : []));
		const matchingKeys = new Set(matching.map(u => u.toString()));
		editor.uri = single(markdownTabUris(true).filter(u =>
			!claimed.has(u.toString()) && (matching.length === 0 || matchingKeys.has(u.toString()))));
	}
	return editor.uri;
}

function forget(editor: Editor): void {
	clearTimeout(editor.silence);
	editor.listener.dispose();
	editors.delete(editor.webview);
}

/** Drops the editors whose tab is closed. */
function prune(): void {
	const open = new Set(markdownTabUris(false).map(u => u.toString()));
	for (const editor of [...editors.values()]) {
		if (editor.uri ? !open.has(editor.uri.toString()) : open.size === 0) {
			forget(editor);
		}
	}
}

function parseSelection(message: unknown): Offsets | null | undefined {
	if (!message || typeof message !== 'object' || (message as { type?: unknown }).type !== messageType) {
		return undefined;
	}
	const selection = (message as { selection?: Partial<Offsets> | null }).selection;
	if (selection === null || selection === undefined) {
		return null;
	}
	const { anchor, active } = selection;
	return Number.isInteger(anchor) && Number.isInteger(active) && anchor! >= 0 && active! >= 0 ? { anchor: anchor!, active: active! } : undefined;
}

const offsetsKey = (o: Offsets | null | undefined): string => o ? `${o.anchor}:${o.active}` : '';

function isActiveTab(uri: vscode.Uri | undefined): boolean {
	const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
	return !!uri && input instanceof vscode.TabInputCustom && input.viewType === viewType && input.uri.toString() === uri.toString();
}

function rangeOf(doc: vscode.TextDocument, offsets: Offsets): vscode.Range {
	const a = doc.positionAt(offsets.anchor);
	const b = doc.positionAt(offsets.active);
	return a.isBefore(b) ? new vscode.Range(a, b) : new vscode.Range(b, a);
}

/** Gives the selection to Claude Code's selection listeners, as if a text editor had changed it, for the CLI. */
function feedListeners(editor: Editor, doc: vscode.TextDocument, offsets: Offsets): void {
	if (!selectionListeners.size) {
		reportOnce('cli', 'no Claude Code selection listener found, so the CLI gets no selection; Claude Code may have subscribed before the bridge started, and the prompt hook note carries the selection.');
		return;
	}
	const selection = new vscode.Selection(doc.positionAt(offsets.anchor), doc.positionAt(offsets.active));
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
	if (fed && editor.selection === offsets) {
		cli = { editor, offsets: offsetsKey(offsets) };
	}
}

/** Gives a selection to Claude Code: the CLI through its listeners, and its chat panel's chip by posting to every webview as Claude Code does. */
async function deliver(editor: Editor): Promise<void> {
	try {
		const { selection, uri } = editor;
		if (!selection || !uri) {
			return;
		}
		const doc = await vscode.workspace.openTextDocument(uri);
		if (editor.selection !== selection) {
			return; // A newer selection is on its way.
		}
		feedListeners(editor, doc, selection);
		if (!postToWebview) {
			return;
		}
		const range = rangeOf(doc, selection);
		const base = { filePath: doc.fileName, sourceUri: doc.uri.toString(), startLine: range.start.line + 1 };
		let payload: ChipSelection | undefined;
		if (!range.isEmpty) {
			payload = { ...base, endLine: range.end.line + 1, startColumn: range.start.character, endColumn: range.end.character, selectedText: doc.getText(range) };
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
		if (posted.some(Boolean) && editor.selection === selection) {
			chip = { editor, offsets: offsetsKey(selection) };
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

/** Returns the HTML to set, with the script inserted when the page is the Markdown Editor's. */
function patchPage(webview: vscode.Webview, html: string): string {
	const nonce = /name="vscode-markdown-editor-script-nonce" content="([A-Za-z0-9+/=_-]+)"/.exec(html)?.[1];
	if (!nonce || !html.includes('<head>')) {
		reportOnce('page', 'the Markdown Editor page has no script nonce or no <head>; its selection is not read.');
		return html;
	}
	let content: string | undefined;
	try {
		const encoded = /id="vscode-markdown-editor-initial-state" content="([^"]*)"/.exec(html)?.[1];
		const state = encoded === undefined ? undefined : JSON.parse(decodeURIComponent(encoded)) as { content?: unknown };
		content = typeof state?.content === 'string' ? state.content : undefined;
	} catch {
		content = undefined;
	}
	if (content === undefined) {
		reportOnce('state', 'the Markdown Editor page has no readable initial state; editors are matched to files by their tabs only.');
	}
	const previous = editors.get(webview);
	if (previous) {
		forget(previous);
	}
	const editor: Editor = {
		webview, content, uri: previous?.uri, selection: undefined, updated: ++clock,
		silence: setTimeout(() => reportOnce('silent', 'a Markdown Editor sent no selection message; acquireVsCodeApi may have changed.'), 10_000),
		listener: webview.onDidReceiveMessage((message: unknown) => {
			try {
				const selection = parseSelection(message);
				if (selection !== undefined) {
					clearTimeout(editor.silence);
					const changed = offsetsKey(selection) !== offsetsKey(editor.selection);
					editor.selection = selection ?? undefined;
					editor.updated = ++clock;
					if (resolve(editor) && changed && editor.selection && isActiveTab(editor.uri)) {
						void deliver(editor);
					}
				}
			} catch (err) {
				reportOnce('message', `a selection message failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}),
	};
	editor.silence.unref();
	editors.set(webview, editor);
	return html.replace('<head>', () => `<head><script nonce="${nonce}">${forwarder}</script>`);
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
 * Starts reading Markdown Editor selections; dispose to restore the `html`
 * setter and `postMessage`. A webview shows the patched page for as long as it lives.
 */
export function installMarkdownSelection(log: (message: string) => void): vscode.Disposable {
	report = log;
	// Every extension's webviews share one prototype, so a throwaway panel gives access to the setter the Markdown extension uses. It opens in the active group: a new group would stay behind when workbench.editor.closeEmptyGroups is off.
	const panel = vscode.window.createWebviewPanel('vscodeToolsBridge.probe', 'VS Code Bridge for Claude Code', { viewColumn: vscode.ViewColumn.Active, preserveFocus: true }, {});
	const prototype: object | null = Object.getPrototypeOf(panel.webview);
	panel.dispose();
	const html = findOwner(prototype, 'html');
	const originalSet = html?.descriptor.set;
	if (!html || !originalSet || !html.descriptor.configurable) {
		reportOnce('setter', 'the webview has no configurable html setter; the selection is not read.');
		return { dispose: () => undefined };
	}
	const { owner, descriptor } = html;
	let active = true;
	const patched: PropertyDescriptor = {
		...descriptor,
		set(this: vscode.Webview, value: unknown) {
			let page = value;
			if (active && typeof value === 'string' && value.includes('vscode-markdown-editor-message-secret')) {
				try {
					page = patchPage(this, value);
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

	const disposables = [
		// Claude Code replaces the chip with a text editor's selection on these events.
		vscode.window.onDidChangeActiveTextEditor(editor => { chip = editor ? undefined : chip; }),
		vscode.window.onDidChangeTextEditorSelection(e => {
			chip = e.textEditor === vscode.window.activeTextEditor ? undefined : chip;
			cli = undefined; // The CLI's listener takes every text editor's selection.
		}),
	];
	// Claude Code may have cleared its chip while another tab was in front, so a Markdown Editor that comes to the front sends its selection again.
	let frontUri: string | undefined;
	const onTabs = () => {
		const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
		const uri = input instanceof vscode.TabInputCustom && input.viewType === viewType ? input.uri.toString() : undefined;
		if (uri && uri !== frontUri) {
			const newest = [...editors.values()].filter(e => resolve(e)?.toString() === uri && e.selection).sort((a, b) => b.updated - a.updated)[0];
			if (newest) {
				void deliver(newest);
			}
		}
		frontUri = uri;
	};
	disposables.push(
		vscode.window.tabGroups.onDidChangeTabs(e => {
			if (e.closed.length) {
				prune();
			}
			onTabs();
		}),
		vscode.window.tabGroups.onDidChangeTabGroups(onTabs),
	);
	return {
		dispose() {
			active = false;
			running = false;
			disposables.forEach(d => d.dispose());
			for (const editor of [...editors.values()]) {
				forget(editor);
			}
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
export const markdownSelectionRunning = (): boolean => running;

/** The Markdown Editor in front of each editor group, with its selection. */
export async function markdownEditorSelections(): Promise<MarkdownEditorState[]> {
	prune();
	const out: MarkdownEditorState[] = [];
	for (const group of vscode.window.tabGroups.all) {
		const input = group.activeTab?.input;
		if (!(input instanceof vscode.TabInputCustom) || input.viewType !== viewType) {
			continue;
		}
		const state: MarkdownEditorState = { uri: input.uri, active: group.isActive, delivered: { chip: false, cli: false } };
		const newest = [...editors.values()]
			.filter(e => resolve(e)?.toString() === input.uri.toString())
			.sort((a, b) => b.updated - a.updated)[0];
		if (newest?.selection) {
			try {
				const doc = await vscode.workspace.openTextDocument(input.uri);
				const { start, end } = rangeOf(doc, newest.selection);
				state.selection = {
					startLine: start.line + 1,
					// A selection that ends at the start of a line does not include that line.
					endLine: (end.line > start.line && end.character === 0 ? end.line - 1 : end.line) + 1,
					text: doc.getText(new vscode.Range(start, end)),
				};
				const key = offsetsKey(newest.selection);
				state.delivered = { chip: chip?.editor === newest && chip.offsets === key, cli: cli?.editor === newest && cli.offsets === key };
			} catch (err) {
				reportOnce('read', `reading ${input.uri.toString()} failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		out.push(state);
	}
	return out;
}
