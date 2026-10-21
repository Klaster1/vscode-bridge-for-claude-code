// Reads the selection in VS Code's rich Markdown Editor (the custom editor
// vscode.markdown.editor), as a page handler of webviewSelection.ts. For the
// Markdown Editor's page it inserts one script, which wraps acquireVsCodeApi so
// that the editor's setState calls, made on every selection change, also post
// the selection's offsets into the Markdown source to this extension. The
// script reads nothing else from the page.

import * as vscode from 'vscode';
import { deliver, delivered, reporter, type Delivered, type PageHandler } from './webviewSelection.ts';

const viewType = 'vscode.markdown.editor';
const messageType = 'vscodeBridge.markdownSelection';

/** Offsets into the Markdown source, in the order the user made the selection. */
interface Offsets { anchor: number; active: number }

interface Editor {
	webview: vscode.Webview;
	listener: vscode.Disposable;
	silence: NodeJS.Timeout;
	/** The document text when the page was built; matches the editor's document while it is unedited. */
	content: string | undefined;
	uri: vscode.Uri | undefined;
	/** Undefined until the editor reports; null when it has no selection, as after a click outside its text. */
	selection: Offsets | null | undefined;
	/** Orders editors that show the same file: the newest one's selection wins. */
	updated: number;
}

interface MarkdownEditorState {
	uri: vscode.Uri;
	active: boolean;
	/** Absent when the editor has not reported a selection. Lines are 1-based; an empty `text` means a cursor. */
	selection?: { startLine: number; endLine: number; text: string };
	delivered: Delivered;
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
let clock = 0;
const reportOnce = reporter('Markdown Editor selection');

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

const offsetsKey = (o: Offsets | null | undefined): string => o ? `${o.anchor}:${o.active}` : o === null ? 'none' : '';

function isActiveTab(uri: vscode.Uri | undefined): boolean {
	const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
	return !!uri && input instanceof vscode.TabInputCustom && input.viewType === viewType && input.uri.toString() === uri.toString();
}

function rangeOf(doc: vscode.TextDocument, offsets: Offsets): vscode.Range {
	const a = doc.positionAt(offsets.anchor);
	const b = doc.positionAt(offsets.active);
	return a.isBefore(b) ? new vscode.Range(a, b) : new vscode.Range(b, a);
}

function deliverEditor(editor: Editor): Promise<void> {
	const { selection, uri } = editor;
	if (selection === undefined || !uri) {
		return Promise.resolve();
	}
	return deliver(editor, offsetsKey(selection), async () => {
		const doc = await vscode.workspace.openTextDocument(uri);
		if (editor.selection !== selection) {
			return undefined; // A newer selection is on its way.
		}
		// With no selection the file still goes to Claude Code, as for a text editor's cursor; the start of the file stands in for it.
		const [anchor, active] = selection ? [selection.anchor, selection.active] : [0, 0];
		return { doc, selection: new vscode.Selection(doc.positionAt(anchor), doc.positionAt(active)) };
	}, () => editor.selection === selection);
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
					editor.selection = selection;
					editor.updated = ++clock;
					if (resolve(editor) && changed && isActiveTab(editor.uri)) {
						void deliverEditor(editor);
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

// Claude Code may have cleared its chip while another tab was in front, so a Markdown Editor that comes to the front sends its selection again.
let frontUri: string | undefined;

export const markdownEditorPage: PageHandler = {
	matches: html => html.includes('vscode-markdown-editor-message-secret'),
	patch: patchPage,
	tabsChanged(closed) {
		if (closed) {
			prune();
		}
		const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
		const uri = input instanceof vscode.TabInputCustom && input.viewType === viewType ? input.uri.toString() : undefined;
		if (uri && uri !== frontUri) {
			const newest = [...editors.values()].filter(e => resolve(e)?.toString() === uri && e.selection !== undefined).sort((a, b) => b.updated - a.updated)[0];
			if (newest) {
				void deliverEditor(newest);
			}
		}
		frontUri = uri;
	},
	clear() {
		for (const editor of [...editors.values()]) {
			forget(editor);
		}
		frontUri = undefined;
	},
};

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
				state.delivered = delivered(newest, offsetsKey(newest.selection));
			} catch (err) {
				reportOnce('read', `reading ${input.uri.toString()} failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		out.push(state);
	}
	return out;
}
