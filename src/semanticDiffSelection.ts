// Reads the selection in a SemanticDiff diff panel (extension semanticdiff.semanticdiff), as a
// page handler of webviewSelection.ts. SemanticDiff keeps its selection in its viewer object and
// draws it itself, so the DOM has none. The inserted script catches that object while
// SemanticDiff's own script builds it, and posts the selection after each change. The extension
// side learns the compared files from the page's initial state and SemanticDiff's SetState
// messages, and gives Claude Code the selection in the file of the side it is on.
//
// The page can be in SemanticDiff's own panel or in a tab of another extension that shows
// SemanticDiff's page, such as a custom diff editor. Which page is in front comes from the
// webview's panel, which webviewSelection.ts finds through the panel's `webview` getter.

import * as vscode from 'vscode';
import { deliver, delivered, pageOf, panelOf, reporter, setPage, type Delivered, type Delivery, type PageHandler } from './webviewSelection.ts';

const messageType = 'vscodeBridge.semanticDiffSelection';

/** A selection as the page reports it: 1-based lines and 0-based columns in the file of its side. */
export interface PageSelection {
	side: 'original' | 'modified';
	startLine: number;
	startColumn: number;
	endLine: number;
	endColumn: number;
	/** The text the panel shows as selected; empty for a cursor. */
	text: string;
}

interface Panel {
	webview: vscode.Webview;
	listener: vscode.Disposable;
	silence: NodeJS.Timeout;
	original: vscode.Uri | undefined;
	modified: vscode.Uri | undefined;
	/** SemanticDiff's title for the diff. */
	title: string | undefined;
	selection: PageSelection | undefined;
	/** The webview's panel, once an extension has read it through `panel.webview`. */
	owner: vscode.WebviewPanel | undefined;
	ownerEvents: vscode.Disposable | undefined;
	/** Whether the owner was the active editor at its last view state change. */
	wasActive: boolean;
}

export interface SemanticDiffState {
	label: string;
	original: vscode.Uri | undefined;
	modified: vscode.Uri | undefined;
	active: boolean;
	/** Absent when nothing is selected. Lines are 1-based; an empty `text` means a cursor. */
	selection?: { side: PageSelection['side']; startLine: number; endLine: number; text: string };
	delivered: Delivered;
}

/**
 * The script inserted into SemanticDiff's page, before SemanticDiff's own script runs. The viewer
 * is the only object that assigns `selectionText`, in its constructor, so a setter for that name
 * on Object.prototype catches it. The setter then gives the viewer an own property, so the rest
 * of SemanticDiff sees a plain field. updateSelectionText runs after a drag, a click and a
 * double-click; clear runs when the panel renders the diff again and drops the selection.
 */
export const pageScript = `(() => {
	const acquire = globalThis.acquireVsCodeApi;
	if (typeof acquire !== 'function') { return; }
	let api;
	globalThis.acquireVsCodeApi = function () {
		api = acquire.apply(this, arguments);
		return api;
	};
	const post = selection => {
		try { api && api.postMessage({ type: '${messageType}', selection }); } catch { /* SemanticDiff must keep working */ }
	};
	const marker = '\\u21B5'; // SemanticDiff appends it to a line whose line ending changed.
	const lineText = item => String(item.code.text).replace(new RegExp(marker + '$'), '');
	const read = viewer => {
		const sel = viewer.selection, renderer = viewer.renderer;
		if (!sel || !sel.hasOffset || !sel.start || !sel.end || !renderer || !Array.isArray(renderer.rows)) { return null; }
		const side = sel.leftSide ? 'original' : 'modified';
		const items = row => { const r = renderer.rows[row]; return r && r.type === 2 ? (sel.leftSide ? r.left : r.right) || [] : undefined; };
		const selectable = item => item && item.canSelect && item.line && item.code;
		const clamp = (offset, text) => Math.max(0, Math.min(offset === undefined ? text.length : offset, text.length));
		if (sel.start.row === sel.end.row && sel.start.line === sel.end.line && sel.start.offset === sel.end.offset) {
			const item = (items(sel.start.row) || [])[sel.start.line];
			if (!selectable(item)) { return null; }
			const line = Number(item.line.text), column = clamp(sel.start.offset, lineText(item));
			return { side, startLine: line, startColumn: column, endLine: line, endColumn: column, text: '' };
		}
		const s = renderer.simplifySelection(sel);
		if (!s) { return null; }
		const pieces = [];
		for (let row = s.start.row; row <= s.end.row; row++) {
			const r = renderer.rows[row];
			if (r && r.type === 1) { pieces.push({ text: '[...]' }); continue; } // A collapsed run of lines, shown as in SemanticDiff's own copy.
			const list = items(row);
			if (!list) { continue; }
			for (let index = 0; index < list.length; index++) {
				const item = list[index];
				if (!selectable(item) || (row === s.start.row && index < s.start.line)) { continue; }
				if (row === s.end.row && index > s.end.line) { break; }
				const text = lineText(item);
				const from = row === s.start.row && index === s.start.line ? clamp(s.start.offset, text) : 0;
				const to = row === s.end.row && index === s.end.line ? clamp(s.end.offset, text) : text.length;
				pieces.push({ line: Number(item.line.text), from, to, length: text.length, text: text.slice(from, to) });
			}
		}
		const lines = pieces.filter(p => p.line !== undefined);
		if (!lines.length) { return null; }
		const text = pieces.map(p => p.text).join('\\n');
		const first = lines[0], last = lines[lines.length - 1];
		if (lines.every((p, i) => i === 0 || p.line > lines[i - 1].line)) {
			return { side, startLine: first.line, startColumn: first.from, endLine: last.line, endColumn: last.to, text };
		}
		// Moved code compared with its original shows the original's lines out of file order: report whole lines from the lowest to the highest.
		const low = lines.reduce((a, b) => b.line < a.line ? b : a), high = lines.reduce((a, b) => b.line > a.line ? b : a);
		return { side, startLine: low.line, startColumn: 0, endLine: high.line, endColumn: high.length, text };
	};
	const watch = viewer => {
		const update = viewer.updateSelectionText, clear = viewer.clear;
		if (typeof update !== 'function' || typeof clear !== 'function' || !viewer.renderer) { return; }
		viewer.updateSelectionText = function () {
			const result = update.apply(this, arguments);
			try { post(read(this)); } catch { post(null); }
			return result;
		};
		viewer.clear = function () {
			const result = clear.apply(this, arguments);
			post(null);
			return result;
		};
		post(null); // Tells the extension the viewer was found.
	};
	Object.defineProperty(Object.prototype, 'selectionText', {
		configurable: true,
		set(value) {
			Object.defineProperty(this, 'selectionText', { value, writable: true, enumerable: true, configurable: true });
			try { watch(this); } catch { /* the viewer stays as it is */ }
		},
	});
})();`;

const panels = new Map<vscode.Webview, Panel>();
const reportOnce = reporter('SemanticDiff selection');

const isSemanticDiffPage = (html: string): boolean =>
	html.includes('<title>SemanticDiff</title>') && html.includes('id="old-path"') && html.includes('id="new-path"');

/** The files and title in SemanticDiff's state, from its page or a SetState message. */
export function readState(state: unknown): { original?: string; modified?: string; title?: string } {
	const s = state as { input?: { original?: unknown; modified?: unknown }; title?: unknown } | null | undefined;
	return {
		...typeof s?.input?.original === 'string' ? { original: s.input.original } : {},
		...typeof s?.input?.modified === 'string' ? { modified: s.input.modified } : {},
		...typeof s?.title === 'string' ? { title: s.title } : {},
	};
}

/** The state SemanticDiff writes into its page as `initialState = JSON.parse(decodeURIComponent("…"))`. */
export function initialState(html: string): unknown {
	const encoded = /initialState\s*=\s*JSON\.parse\(decodeURIComponent\("([^"]*)"\)\)/.exec(html)?.[1];
	return encoded === undefined ? undefined : JSON.parse(decodeURIComponent(encoded)) as unknown;
}

const isLine = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1;
const isColumn = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0;

/** The page's selection; null when it has none, undefined when the message is not a valid one. */
export function parseSelection(message: unknown): PageSelection | null | undefined {
	if (!message || typeof message !== 'object' || (message as { type?: unknown }).type !== messageType) {
		return undefined;
	}
	const selection = (message as { selection?: Partial<PageSelection> | null }).selection;
	if (selection === null || selection === undefined) {
		return null;
	}
	const { side, startLine, startColumn, endLine, endColumn, text } = selection;
	if ((side !== 'original' && side !== 'modified') || !isLine(startLine) || !isLine(endLine) || startLine > endLine
		|| !isColumn(startColumn) || !isColumn(endColumn) || typeof text !== 'string') {
		return undefined;
	}
	return { side, startLine, startColumn, endLine, endColumn, text };
}

const selectionKey = (s: PageSelection | undefined): string => s ? `${s.side}:${s.startLine}:${s.startColumn}:${s.endLine}:${s.endColumn}` : '';

/**
 * The selection as a range of the side's document. `text` is set when the document holds other
 * text in that range than the panel showed, such as a run of lines the panel had collapsed.
 */
export function toDelivery(doc: vscode.TextDocument, s: PageSelection): Delivery {
	const start = doc.validatePosition(new vscode.Position(s.startLine - 1, s.startColumn));
	const end = doc.validatePosition(new vscode.Position(s.endLine - 1, s.endColumn));
	const fromDoc = doc.getText(new vscode.Range(start, end));
	return { doc, selection: new vscode.Selection(start, end), ...fromDoc.replaceAll('\r\n', '\n') === s.text ? {} : { text: s.text } };
}

const sideUri = (panel: Panel, s: PageSelection): vscode.Uri | undefined => s.side === 'original' ? panel.original : panel.modified;

function forget(panel: Panel): void {
	clearTimeout(panel.silence);
	panel.listener.dispose();
	panel.ownerEvents?.dispose();
	panels.delete(panel.webview);
}

/** Where a page is: in front of its group, in the active group, and which group. */
interface View { visible: boolean; active: boolean; column: number }

/** Takes the webview's panel once it is known, and follows its view state and disposal. */
function bind(panel: Panel): vscode.WebviewPanel | undefined {
	const owner = panel.owner ?? panelOf(panel.webview);
	if (owner && !panel.owner) {
		panel.owner = owner;
		try {
			panel.wasActive = owner.active;
			panel.ownerEvents = vscode.Disposable.from(
				// Claude Code may have cleared its chip while another editor was active, so a page that becomes active again sends its selection again.
				owner.onDidChangeViewState(() => {
					const active = owner.active;
					if (!owner.visible && !owner.options.retainContextWhenHidden) {
						panel.selection = undefined; // VS Code drops a hidden page, and it comes back with no selection.
					} else if (active && !panel.wasActive && panel.selection) {
						void deliverPanel(panel);
					}
					panel.wasActive = active;
				}),
				owner.onDidDispose(() => forget(panel)),
			);
		} catch {
			forget(panel); // A disposed panel throws on every property.
			return undefined;
		}
	}
	return owner;
}

function viewOf(panel: Panel): View | undefined {
	const owner = bind(panel);
	try {
		return owner && { visible: owner.visible, active: owner.active, column: owner.viewColumn ?? 0 };
	} catch {
		forget(panel); // A disposed panel throws on every property.
		return undefined;
	}
}

function deliverPanel(panel: Panel): Promise<void> {
	const selection = panel.selection;
	const uri = selection && sideUri(panel, selection);
	if (!selection || !uri) {
		if (selection) {
			reportOnce('files', 'a SemanticDiff panel\'s state names no compared files; its selection reaches only the tool and the prompt hook.');
		}
		return Promise.resolve();
	}
	return deliver(panel, selectionKey(selection), async () => {
		const doc = await vscode.workspace.openTextDocument(uri);
		return panel.selection === selection ? toDelivery(doc, selection) : undefined;
	}, () => panel.selection === selection);
}

function setFiles(panel: Panel, state: unknown): void {
	const { original, modified, title } = readState(state);
	panel.original = original === undefined ? panel.original : vscode.Uri.parse(original);
	panel.modified = modified === undefined ? panel.modified : vscode.Uri.parse(modified);
	panel.title = title ?? panel.title;
}

function patchPage(webview: vscode.Webview, html: string): string {
	if (!html.includes('<head>')) {
		reportOnce('page', 'the SemanticDiff page has no <head>; its selection is not read.');
		return html;
	}
	const previous = panels.get(webview);
	if (previous) {
		forget(previous);
	}
	const panel: Panel = {
		webview, original: previous?.original, modified: previous?.modified, title: previous?.title, selection: undefined,
		owner: undefined, ownerEvents: undefined, wasActive: false,
		silence: setTimeout(() => reportOnce('silent', 'a SemanticDiff panel sent no selection message; its viewer or acquireVsCodeApi may have changed.'), 10_000),
		listener: webview.onDidReceiveMessage((message: unknown) => {
			try {
				const selection = parseSelection(message);
				if (selection !== undefined) {
					clearTimeout(panel.silence);
					const changed = selectionKey(selection ?? undefined) !== selectionKey(panel.selection);
					panel.selection = selection ?? undefined;
					if (changed && panel.selection) {
						void deliverPanel(panel); // The user made it in the page, so the page is in front.
					}
				}
			} catch (err) {
				reportOnce('message', `a selection message failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}),
	};
	try {
		setFiles(panel, initialState(html));
	} catch {
		// SetState names the files later.
	}
	if (!panel.modified) {
		reportOnce('state', 'the SemanticDiff page has no readable initial state; its files come from its next SetState message.');
	}
	panel.silence.unref();
	panels.set(webview, panel);
	bind(panel);
	// An extension that shows SemanticDiff's page can set the page again as it is, script included.
	return html.includes(pageScript) ? html : html.replace('<head>', () => `<head><script>${pageScript}</script>`);
}

const checking = new WeakSet<vscode.Webview>();

/** Sets a SemanticDiff page again with the script when it was set past the bridge's setter. */
function patchLate(webview: vscode.Webview): boolean {
	const page = pageOf(webview);
	if (panels.has(webview) || !page || !isSemanticDiffPage(page) || page.includes(pageScript)) {
		return false;
	}
	reportOnce('late', 'a SemanticDiff page was set through an html setter taken before the bridge\'s patch was in place, so the bridge sets it again with its script.');
	setPage(webview, page); // The page reloads from the state it saved, or from its initial state.
	return true;
}

export const semanticDiffPage: PageHandler = {
	reportsSelection: true,
	matches: isSemanticDiffPage,
	patch: patchPage,
	posted(webview, message) {
		const panel = panels.get(webview);
		if (panel && (message as { type?: unknown } | null)?.type === 'SetState') {
			setFiles(panel, (message as { state?: unknown }).state);
		}
	},
	seen(webview) {
		const panel = panels.get(webview);
		if (panel) {
			bind(panel);
			return;
		}
		// An extension that took the html setter before the bridge started sets the page past the bridge. SemanticDiff reads
		// `panel.webview` in the statement that sets the page, so a blank page is checked again once that statement has run.
		if (!patchLate(webview) && pageOf(webview) === '' && !checking.has(webview)) {
			checking.add(webview);
			setTimeout(() => {
				checking.delete(webview);
				try {
					patchLate(webview);
				} catch (err) {
					reportOnce('late-failed', `setting a SemanticDiff page again failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			}, 0);
		}
	},
	clear() {
		for (const panel of [...panels.values()]) {
			forget(panel);
		}
	},
};

/** The SemanticDiff page in front of each editor group, with its selection. */
export async function semanticDiffSelections(): Promise<SemanticDiffState[]> {
	const shown = [...panels.values()].flatMap(panel => {
		const view = viewOf(panel);
		return view?.visible ? [{ panel, view }] : [];
	}).sort((a, b) => a.view.column - b.view.column);
	const out: SemanticDiffState[] = [];
	for (const { panel, view } of shown) {
		const state: SemanticDiffState = { label: panel.title ?? 'SemanticDiff', original: panel.original, modified: panel.modified, active: view.active, delivered: { chip: false, cli: false } };
		const s = panel.selection;
		if (s) {
			// A selection that ends at the start of a line does not include that line.
			const endLine = s.endLine > s.startLine && s.endColumn === 0 ? s.endLine - 1 : s.endLine;
			state.selection = { side: s.side, startLine: s.startLine, endLine, text: s.text };
			const uri = sideUri(panel, s);
			if (uri && s.text) {
				try {
					const { doc, selection, text } = toDelivery(await vscode.workspace.openTextDocument(uri), s);
					state.selection.text = text ?? doc.getText(selection);
				} catch (err) {
					reportOnce('read', `reading ${uri.toString()} failed, so the panel's text is used: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			state.delivered = delivered(panel, selectionKey(s));
		}
		out.push(state);
	}
	return out;
}
