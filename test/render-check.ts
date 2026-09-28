// Offline check of src/render.ts: builds a prompt-tsx tool result the way
// Copilot's tools do (renderElementJSON over nested elements), wraps it in a
// LanguageModelPromptTsxPart, and asserts the bridge renders it to plain text
// rather than JSON. Needed because Copilot's own tools cannot run in the
// signed-out test instance. 'vscode' is served from test/vscode-stub.ts.
//
//   node test/render-check.ts

import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import type * as Vscode from 'vscode';

const stub = pathToFileURL(join(import.meta.dirname, 'vscode-stub.ts')).href;
registerHooks({
	resolve(specifier, context, next) {
		return specifier === 'vscode' ? { url: stub, shortCircuit: true } : next(specifier, context);
	},
});

const vscode = await import('vscode') as unknown as typeof Vscode;
const { default: promptTsx } = await import('@vscode/prompt-tsx');
const { toolResultToContent } = await import('../src/render.ts');
const { PromptElement, TextChunk, renderElementJSON } = promptTsx;

class FileList extends PromptElement {
	render() {
		return vscpp(vscppf, {},
			vscpp(TextChunk, {}, 'Found 2 matches'),
			vscpp('br', {}),
			vscpp(TextChunk, { priority: 10 }, 'src/greet.ts:1 export function newGreeting'),
			vscpp('br', {}),
			vscpp(TextChunk, { priority: 5 }, 'src/use.ts:3 newGreeting(\'bridge\')'),
		) as unknown as import('@vscode/prompt-tsx').PromptPiece;
	}
}

const json = await renderElementJSON(FileList, {}, undefined);
const result = new vscode.LanguageModelToolResult([
	new vscode.LanguageModelTextPart('Plain part.'),
	new vscode.LanguageModelPromptTsxPart(json),
	new vscode.LanguageModelDataPart(new Uint8Array([137, 80, 78, 71]), 'image/png'),
]);
const content = await toolResultToContent(result);
console.log(JSON.stringify(content, null, 2));

const rendered = content[1];
const ok = content[0]?.type === 'text' && content[0].text === 'Plain part.'
	&& rendered?.type === 'text' && rendered.text.includes('Found 2 matches') && rendered.text.includes('src/use.ts:3') && !rendered.text.includes('"node"')
	&& content[2]?.type === 'image' && content[2].mimeType === 'image/png';
console.log(ok ? 'PASS  prompt-tsx part rendered to text; image part kept as MCP image' : 'FAIL  unexpected render output');
process.exit(ok ? 0 : 1);
