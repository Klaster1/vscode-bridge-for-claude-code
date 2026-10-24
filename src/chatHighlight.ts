// Syntax highlighting for the code blocks in Claude Code's chat panel, which draws them as plain
// text. A script inserted into the chat page sends each fenced block's language and text to the
// extension host, which colors it as the editor would (src/textmate.ts). The page paints the
// answer with the CSS Custom Highlight API: it styles ranges of the existing text and leaves the
// DOM alone, which Claude Code's React owns and updates while an answer streams in.

import * as vscode from 'vscode';
import { addPageHandler, installWebviewSelection, reporter, type PageHandler } from './webviewSelection.ts';
import { createTokenizer, type Contributes, type Sources } from './textmate.ts';

const requestType = 'vscodeBridge.highlight';
const replyType = 'vscodeBridge.highlighted';
const restyleType = 'vscodeBridge.restyle';
const reportOnce = reporter('Chat syntax highlighting');

const sources: Sources = {
	extensions: () => vscode.extensions.all.map(extension => ({ path: extension.extensionPath, contributes: (extension.packageJSON as { contributes?: Contributes }).contributes ?? {} })),
	theme: () => vscode.workspace.getConfiguration('workbench').get<string>('colorTheme'),
	customizations: () => vscode.workspace.getConfiguration('editor').get<unknown>('tokenColorCustomizations'),
};
const tokenizer = createTokenizer(sources);

/**
 * The script inserted into Claude Code's page, before Claude Code's own script runs. It catches
 * the VS Code API object that Claude Code gets, to post requests, and it stops its own messages
 * from reaching Claude Code's listeners. It looks only at the code blocks a change touched, and
 * asks again for a block that keeps changing, as one does while its answer streams in, no more
 * often than every 300 ms.
 */
export const pageScript = `(() => {
	if (!globalThis.CSS || !CSS.highlights || typeof Highlight !== 'function') { return; }
	const acquire = globalThis.acquireVsCodeApi;
	if (typeof acquire !== 'function') { return; }
	let api;
	globalThis.acquireVsCodeApi = function () {
		api = acquire.apply(this, arguments);
		return api;
	};
	const sheet = document.createElement('style');
	(document.head || document.documentElement).appendChild(sheet);
	const highlights = new Map(); // A color: its Highlight.
	const blocks = new Map(); // A code element: the text it was requested for, the ranges painted on it and when it was last requested.
	const pending = new Map(); // A request ID: its code element and text.
	const cache = new Map(); // A language and text: the tokens for it.
	const dirty = new Set(); // The code elements a change touched.
	const selector = 'pre > code[class*="language-"]';
	let seq = 0;
	let timer;

	const highlightFor = color => {
		let h = highlights.get(color);
		if (!h) {
			const name = 'vscb-' + color.replace(/[^0-9a-f]/gi, '');
			sheet.textContent += '::highlight(' + name + ') { color: ' + color + '; }';
			h = new Highlight();
			CSS.highlights.set(name, h);
			highlights.set(color, h);
		}
		return h;
	};
	const unpaint = state => {
		for (const [h, r] of state.ranges) { h.delete(r); }
		state.ranges = [];
	};
	const paint = (code, state, tokens) => {
		unpaint(state);
		const nodes = [];
		const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
		for (let n = walker.nextNode(), at = 0; n; n = walker.nextNode()) {
			nodes.push({ node: n, from: at, to: at + n.data.length });
			at += n.data.length;
		}
		const find = offset => nodes.find(n => offset >= n.from && offset <= n.to);
		for (const [start, end, color] of tokens) {
			const a = find(start), b = find(end);
			if (!a || !b) { continue; }
			const range = new Range();
			range.setStart(a.node, start - a.from);
			range.setEnd(b.node, end - b.from);
			const h = highlightFor(color);
			h.add(range);
			state.ranges.push([h, range]);
		}
	};
	const scan = () => {
		for (const [code, state] of blocks) {
			if (!code.isConnected) { unpaint(state); blocks.delete(code); }
		}
		const batch = [...dirty];
		dirty.clear();
		let later = false;
		for (const code of batch) {
			if (!code.isConnected || !code.matches(selector)) { continue; }
			const match = /(?:^|\\s)language-(\\S+)/.exec(code.className);
			const text = code.textContent;
			if (!match || !text) { continue; }
			const key = match[1] + '\\0' + text;
			const state = blocks.get(code) || { key: undefined, ranges: [], sentAt: 0 };
			blocks.set(code, state);
			if (state.key === key) { continue; }
			if (cache.has(key)) { state.key = key; paint(code, state, cache.get(key)); continue; }
			if (Date.now() - state.sentAt < 300) { dirty.add(code); later = true; continue; }
			state.key = key;
			state.sentAt = Date.now();
			const id = ++seq;
			pending.set(id, { code, key });
			try { api && api.postMessage({ type: '${requestType}', id, lang: match[1], text }); } catch { /* Claude Code must keep working */ }
		}
		if (later) { schedule(); }
	};
	const schedule = () => { clearTimeout(timer); timer = setTimeout(scan, 120); };
	const touch = node => {
		const element = node.nodeType === 1 ? node : node.parentElement;
		if (!element) { return; }
		const inside = element.closest('pre > code');
		if (inside) { dirty.add(inside); return; }
		for (const code of element.querySelectorAll('pre > code')) { dirty.add(code); }
	};
	new MutationObserver(records => {
		for (const record of records) {
			touch(record.target);
			record.addedNodes.forEach(touch);
		}
		schedule();
	}).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
	const touchAll = () => { for (const code of document.querySelectorAll(selector)) { dirty.add(code); } schedule(); };

	window.addEventListener('message', event => {
		const message = event.data;
		if (!message || typeof message.type !== 'string' || !message.type.startsWith('vscodeBridge.')) { return; }
		event.stopImmediatePropagation();
		if (message.type === '${restyleType}') {
			for (const state of blocks.values()) { unpaint(state); }
			blocks.clear(); cache.clear(); pending.clear(); highlights.clear();
			CSS.highlights.clear();
			sheet.textContent = '';
			touchAll();
		} else if (message.type === '${replyType}') {
			const request = pending.get(message.id);
			pending.delete(message.id);
			const state = request && blocks.get(request.code);
			if (!request || !state || state.key !== request.key || !request.code.isConnected) { return; }
			cache.set(request.key, message.tokens || []);
			paint(request.code, state, message.tokens || []);
		}
	}, true);
	touchAll();
})();`;

/** Claude Code's chat page, with the nonce its scripts need: the page has the element for its start-up errors and a script nonce in its content security policy. */
const claudePage = (html: string): string | undefined =>
	html.includes('id="claude-error"') ? /script-src 'nonce-([\w+/=-]+)'/.exec(html)?.[1] : undefined;

/** The pages the handler patched. */
const pages = new Set<vscode.Webview>();
let subscriptions: vscode.Disposable | undefined;

const restyleAll = (): void => {
	tokenizer.reset();
	for (const webview of [...pages]) {
		Promise.resolve(webview.postMessage({ type: restyleType })).then(posted => posted === false && pages.delete(webview), () => pages.delete(webview));
	}
};

export const chatHighlightPage: PageHandler = {
	matches: html => claudePage(html) !== undefined,
	receive(webview, message) {
		const { type, id, lang, text } = (message ?? {}) as { type?: unknown; id?: unknown; lang?: unknown; text?: unknown };
		if (type !== requestType) {
			return false;
		}
		if (typeof lang === 'string' && typeof text === 'string') {
			tokenizer.tokenize(lang, text)
				.then(tokens => webview.postMessage({ type: replyType, id, tokens: tokens ?? [] }))
				.then(undefined, (err: unknown) => reportOnce('tokenize', `coloring a code block failed: ${err instanceof Error ? err.message : String(err)}`));
		}
		return true;
	},
	patch(webview, html) {
		const nonce = claudePage(html);
		if (!nonce || !html.includes('<head>')) {
			reportOnce('page', 'Claude Code\'s page has no script nonce or no <head>; its code blocks are not colored.');
			return html;
		}
		pages.add(webview);
		subscriptions ??= vscode.Disposable.from(
			vscode.window.onDidChangeActiveColorTheme(restyleAll),
			vscode.extensions.onDidChange(restyleAll),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('workbench.colorTheme') || e.affectsConfiguration('editor.tokenColorCustomizations')) {
					restyleAll();
				}
			}),
		);
		return html.includes(pageScript) ? html : html.replace('<head>', () => `<head><script nonce="${nonce}">${pageScript}</script>`);
	},
	clear() {
		pages.clear();
		subscriptions?.dispose();
		subscriptions = undefined;
		tokenizer.reset();
	},
};

/** Starts coloring the code blocks in Claude Code's chat pages from now on; dispose to stop. A page already open keeps its script, which gets no answers. */
export const installChatHighlighting = (report: (message: string) => void): vscode.Disposable =>
	vscode.Disposable.from(installWebviewSelection(report), addPageHandler(chatHighlightPage));
