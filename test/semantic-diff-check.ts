// Offline check of src/semanticDiffSelection.ts: page recognition, the state and selection
// messages it reads, the range it gives Claude Code, and the page script against a stand-in for
// SemanticDiff's viewer object. 'vscode' is served from test/vscode-stub.ts.
//
//   node test/semantic-diff-check.ts

import { strict as assert } from 'node:assert';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import type * as Vscode from 'vscode';
import { check, finish } from './harness.ts';

const stub = pathToFileURL(join(import.meta.dirname, 'vscode-stub.ts')).href;
registerHooks({
	resolve(specifier, context, next) {
		return specifier === 'vscode' ? { url: stub, shortCircuit: true } : next(specifier, context);
	},
});

const vscode = await import('vscode') as unknown as typeof Vscode;
const { initialState, pageScript, parseSelection, readState, semanticDiffPage, toDelivery } = await import('../src/semanticDiffSelection.ts');

const state = { input: { original: 'git:/c%3A/w/a.ts?%7B%22ref%22%3A%22HEAD%22%7D', modified: 'file:///c%3A/w/a.ts' }, title: 'a.ts (Working Tree)', patch: {} };
// As SemanticDiff fills its page template: the state URI-encoded inside a JSON.parse call.
const page = (initial: string) => `<html>
    <head>
        <title>SemanticDiff</title>
    </head>
    <body>
        <span id="old-path" class="path-elements"></span>
        <span id="new-path" class="path-elements"></span>
        <script>
            initialState = ${initial};
        </script>
        <script src="script.js"></script>
    </body>
</html>`;
const withState = page(`JSON.parse(decodeURIComponent("${encodeURIComponent(JSON.stringify(state))}"))`);

await check('SemanticDiff\'s page is recognised, and a Markdown Editor page or another page is not', () => {
	assert.equal(semanticDiffPage.matches(withState), true);
	assert.equal(semanticDiffPage.matches('<head><meta name="vscode-markdown-editor-message-secret" content="x"></head>'), false);
	assert.equal(semanticDiffPage.matches('<head><title>SemanticDiff</title></head><body>No diff viewer here</body>'), false);
});

await check('the compared files and the title come from the initial state and from SetState', () => {
	assert.deepEqual(readState(initialState(withState)), { original: state.input.original, modified: state.input.modified, title: state.title });
	assert.equal(initialState(page('undefined')), undefined);
	assert.deepEqual(readState({ type: 'ignored', input: { original: 1 } }), {});
});

await check('the script goes right after <head>, before SemanticDiff\'s own script, and only once', () => {
	const webview = { onDidReceiveMessage: () => ({ dispose: () => undefined }) } as unknown as Vscode.Webview;
	const patched = semanticDiffPage.patch(webview, page('undefined'));
	const again = semanticDiffPage.patch(webview, patched); // Another extension can set the page again as it is.
	semanticDiffPage.clear();
	assert.ok(patched.startsWith(`<html>\n    <head><script>${pageScript}</script>`));
	assert.ok(patched.indexOf('script.js') > patched.indexOf(pageScript));
	assert.equal(again, patched);
});

await check('a selection message is read, and an invalid one is ignored', () => {
	const type = 'vscodeBridge.semanticDiffSelection';
	const valid = { side: 'original', startLine: 2, startColumn: 0, endLine: 3, endColumn: 4, text: 'ab\ncdef' };
	assert.deepEqual(parseSelection({ type, selection: valid }), valid);
	assert.equal(parseSelection({ type, selection: null }), null);
	for (const bad of [{ ...valid, side: 'left' }, { ...valid, startLine: 0 }, { ...valid, startLine: 4 }, { ...valid, endColumn: -1 }, { ...valid, text: undefined }]) {
		assert.equal(parseSelection({ type, selection: bad }), undefined, JSON.stringify(bad));
	}
	assert.equal(parseSelection({ type: 'SetState', state }), undefined);
});

await check('the selection maps to the document range, with the panel\'s text only where the document differs', () => {
	const lines = ['first', '\tsecond line', 'third'];
	const doc = {
		validatePosition: (p: Vscode.Position) => new vscode.Position(Math.min(p.line, lines.length - 1), Math.min(p.character, lines[Math.min(p.line, lines.length - 1)]!.length)),
		getText: (r: Vscode.Range) => r.start.line === r.end.line
			? lines[r.start.line]!.slice(r.start.character, r.end.character)
			: [lines[r.start.line]!.slice(r.start.character), ...lines.slice(r.start.line + 1, r.end.line), lines[r.end.line]!.slice(0, r.end.character)].join('\r\n'),
	} as unknown as Vscode.TextDocument;
	const same = toDelivery(doc, { side: 'modified', startLine: 2, startColumn: 1, endLine: 3, endColumn: 3, text: 'second line\nthi' });
	assert.deepEqual([same.selection.start.line, same.selection.start.character, same.selection.end.line, same.selection.end.character], [1, 1, 2, 3]);
	assert.equal(same.text, undefined); // Line endings differ only in form: CRLF in the document, LF from the page.
	const collapsed = toDelivery(doc, { side: 'modified', startLine: 1, startColumn: 0, endLine: 3, endColumn: 5, text: 'first\n[...]\nthird' });
	assert.equal(collapsed.text, 'first\n[...]\nthird');
});

// A stand-in for SemanticDiff's page script: it calls acquireVsCodeApi once, and its viewer assigns
// selectionText in the constructor and keeps the selection as { start, end, leftSide, hasOffset }.
const semanticDiffScript = `
	const api = acquireVsCodeApi();
	class Viewer {
		constructor(renderer) {
			this.renderer = renderer;
			this.selectionText = { tag: 'textarea' };
		}
		updateSelectionText() { this.updated = (this.updated || 0) + 1; }
		clear() { this.selection = undefined; }
	}
	const key = p => [p.row, p.line, p.offset];
	const before = (a, b) => { const x = key(a), y = key(b); for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) { return x[i] < y[i]; } } return false; };
	const item = (line, text) => ({ canSelect: true, line: { text: String(line) }, code: { text } });
	const renderer = {
		rows: [
			{ type: 2, left: [item(1, 'const a = 1;'), item(2, 'const b = 2;\\u21B5')], right: [item(1, 'const a = 10;'), { canSelect: false, code: { text: 'comment thread' } }, item(2, 'const b = 2;')] },
			{ type: 1 },
			{ type: 2, left: [item(9, 'end();')], right: [item(9, 'end();')] },
			{ type: 2, left: [item(7, 'moved();'), item(3, 'early();')], right: [] },
		],
		simplifySelection(s) {
			const [start, end] = before(s.end, s.start) ? [s.end, s.start] : [s.start, s.end];
			return before(start, end) ? { ...s, start: { ...start }, end: { ...end } } : null;
		},
	};
	const viewer = new Viewer(renderer);
	const select = (leftSide, start, end) => { viewer.selection = { start, end, lane: -1, leftSide, hasOffset: true }; viewer.updateSelectionText(); };
`;

await check('the page script reports the viewer\'s selection after each change', () => {
	const posts: { selection: unknown }[] = [];
	const api = { postMessage: (m: { selection: unknown }) => posts.push(JSON.parse(JSON.stringify(m)) as { selection: unknown }) }; // A copy in this realm, which deepEqual needs.
	const context = { acquireVsCodeApi: () => api };
	runInNewContext(`${pageScript}\n${semanticDiffScript}\nthis.page = { api, viewer, select, plain: ({}).selectionText };`, context);
	const { page: p } = context as unknown as { page: { api: unknown; viewer: Record<string, unknown> & { updated?: number; clear(): void }; select(leftSide: boolean, start: object, end: object): void; plain: unknown } };
	assert.equal(p.api, api, 'SemanticDiff must get the real API object');
	assert.equal(JSON.stringify(Object.getOwnPropertyDescriptor(p.viewer, 'selectionText')?.value), '{"tag":"textarea"}');
	assert.equal(p.plain, undefined);
	assert.deepEqual(posts.map(m => m.selection), [null], 'the viewer was caught');
	const last = () => posts.at(-1)?.selection;

	p.select(false, { row: 0, line: 0, offset: 6 }, { row: 2, line: 0, offset: 3 });
	assert.equal(p.viewer.updated, 1, 'SemanticDiff\'s own updateSelectionText still runs');
	assert.deepEqual(last(), { side: 'modified', startLine: 1, startColumn: 6, endLine: 9, endColumn: 3, text: 'a = 10;\nconst b = 2;\n[...]\nend' });

	p.select(true, { row: 0, line: 1, offset: 13 }, { row: 0, line: 0, offset: 6 }); // Dragged upwards, over the line-ending marker.
	assert.deepEqual(last(), { side: 'original', startLine: 1, startColumn: 6, endLine: 2, endColumn: 12, text: 'a = 1;\nconst b = 2;' });

	p.select(true, { row: 3, line: 0, offset: 2 }, { row: 3, line: 1, offset: 4 });
	assert.deepEqual(last(), { side: 'original', startLine: 3, startColumn: 0, endLine: 7, endColumn: 8, text: 'ved();\nearl' }, 'lines out of file order give the whole lines from the lowest to the highest');

	p.select(false, { row: 2, line: 0, offset: 4 }, { row: 2, line: 0, offset: 4 });
	assert.deepEqual(last(), { side: 'modified', startLine: 9, startColumn: 4, endLine: 9, endColumn: 4, text: '' }, 'a click gives a cursor');

	p.viewer.clear();
	assert.equal(last(), null, 'a new render drops the selection');
	assert.equal(p.viewer['selection'], undefined);
});

finish();
