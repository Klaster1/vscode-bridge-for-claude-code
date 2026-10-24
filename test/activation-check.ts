// Offline check that loading src/extension.ts, which is all the extension host does before it calls
// activate(), reaches neither the MCP SDK nor the tools. Those load slowly in a busy host, and the
// bridge must install its patches before a restored Markdown Editor tab activates the Markdown
// extension; a bridge that loses that race reads no Markdown Editor selection at all.
// 'vscode' is served from test/vscode-stub.ts.
//
//   node test/activation-check.ts

import { strict as assert } from 'node:assert';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, finish } from './harness.ts';

const stub = pathToFileURL(join(import.meta.dirname, 'vscode-stub.ts')).href;
const loaded = new Set<string>();
registerHooks({
	resolve(specifier, context, next) {
		const result = specifier === 'vscode' ? { url: stub, shortCircuit: true } : next(specifier, context);
		loaded.add(result.url);
		return result;
	},
});

const extension = await import('../src/extension.ts');

await check('loading the extension module exports activate', () => {
	assert.equal(typeof extension.activate, 'function');
});

await check('loading the extension module leaves the MCP server modules unloaded', () => {
	const heavy = [...loaded].filter(url => /node_modules\/(@modelcontextprotocol|@vscode\/prompt-tsx|zod)\/|\/src\/(tools|render|instructions)\.ts$/.test(url));
	assert.equal(heavy.length, 0, `${heavy.length} modules loaded, such as ${heavy.slice(0, 3).join(', ')}`);
});

finish();
