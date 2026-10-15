// Reads the selection in a SemanticDiff diff panel (extension semanticdiff.semanticdiff), as a
// page handler of webviewSelection.ts. SemanticDiff keeps its selection in its viewer object and
// draws it itself, so the DOM has none. The inserted script catches that object while
// SemanticDiff's own script builds it, and posts the selection after each change. The extension
// side learns the compared files from the page's initial state and SemanticDiff's SetState
// messages, and gives Claude Code the selection in the file of the side it is on.

import * as vscode from 'vscode';
import { deliver, delivered, reporter, type Delivered, type Delivery, type PageHandler } from './webviewSelection.ts';

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
	/** The panel's title, which is also its tab's label. */
	title: string | undefined;
	selection: PageSelection | undefined;
	/** Orders panels with the same title: the newest one's selection wins. */
	updated: number;
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
let clock = 0;
const reportOnce = reporter('SemanticDiff selection');

const isSemanticDiffPage = (html: string): boolean =>
	html.includes('<title>SemanticDiff</title>') && html.includes('id="old-path"') && html.includes('id="new-path"');

/** VS Code reports a panel's view type with a prefix, such as `mainThreadWebview-SemanticDiff`. */
const isSemanticDiffTab = (tab: vscode.Tab | undefined): tab is vscode.Tab & { input: vscode.TabInputWebview } =>
	tab?.input instanceof vscode.TabInputWebview && /(^|-)SemanticDiff$/.test(tab.input.viewType);

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
	panels.delete(panel.webview);
}

const openLabels = (): Set<string> =>
	new Set(vscode.window.tabGroups.all.flatMap(group => group.tabs.filter(isSemanticDiffTab).map(tab => tab.label)));

/** Drops the panels whose tab is closed. */
function prune(): void {
	const open = openLabels();
	for (const panel of [...panels.values()]) {
		if (panel.title === undefined ? open.size === 0 : !open.has(panel.title)) {
			forget(panel);
		}
	}
}

/** The newest panel a SemanticDiff tab shows, matched by the tab's label. */
const panelFor = (tab: vscode.Tab): Panel | undefined =>
	[...panels.values()].filter(p => p.title === undefined || p.title === tab.label).sort((a, b) => b.updated - a.updated)[0];

function isActive(panel: Panel): boolean {
	const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
	return isSemanticDiffTab(tab) && (panel.title === undefined || panel.title === tab.label);
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
		webview, original: previous?.original, modified: previous?.modified, title: previous?.title, selection: undefined, updated: ++clock,
		silence: setTimeout(() => reportOnce('silent', 'a SemanticDiff panel sent no selection message; its viewer or acquireVsCodeApi may have changed.'), 10_000),
		listener: webview.onDidReceiveMessage((message: unknown) => {
			try {
				const selection = parseSelection(message);
				if (selection !== undefined) {
					clearTimeout(panel.silence);
					const changed = selectionKey(selection ?? undefined) !== selectionKey(panel.selection);
					panel.selection = selection ?? undefined;
					panel.updated = ++clock;
					if (changed && panel.selection && isActive(panel)) {
						void deliverPanel(panel);
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
	return html.replace('<head>', () => `<head><script>${pageScript}</script>`);
}

// Claude Code may have cleared its chip while another tab was in front, so a panel that comes to the front sends its selection again.
let frontLabel: string | undefined;

export const semanticDiffPage: PageHandler = {
	matches: isSemanticDiffPage,
	patch: patchPage,
	posted(webview, message) {
		const panel = panels.get(webview);
		if (panel && (message as { type?: unknown } | null)?.type === 'SetState') {
			setFiles(panel, (message as { state?: unknown }).state);
		}
	},
	tabsChanged(closed) {
		if (closed) {
			prune();
		}
		const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
		const label = isSemanticDiffTab(tab) ? tab.label : undefined;
		if (tab && label !== undefined && label !== frontLabel) {
			const panel = panelFor(tab);
			if (panel?.selection) {
				void deliverPanel(panel);
			}
		}
		frontLabel = label;
	},
	clear() {
		for (const panel of [...panels.values()]) {
			forget(panel);
		}
		frontLabel = undefined;
	},
};

/** The SemanticDiff panel in front of each editor group, with its selection. */
export async function semanticDiffSelections(): Promise<SemanticDiffState[]> {
	prune();
	const out: SemanticDiffState[] = [];
	for (const group of vscode.window.tabGroups.all) {
		const tab = group.activeTab;
		if (!isSemanticDiffTab(tab)) {
			continue;
		}
		const panel = panelFor(tab);
		const state: SemanticDiffState = { label: tab.label, original: panel?.original, modified: panel?.modified, active: group.isActive, delivered: { chip: false, cli: false } };
		const s = panel?.selection;
		if (panel && s) {
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
