// Claude Code UserPromptSubmit hook: tells Claude which integrated-browser
// pages the user has shared with the agent in the VS Code window of this
// session, the way Claude Code itself adds the open file. It runs before each
// prompt is sent.
//
// Reads the hook payload from stdin (JSON with the session's `cwd`), finds that
// window's bridge the same way launcher.ts does, asks it over MCP for
// shared_browser_pages without snapshots, and prints
// {"hookSpecificOutput": {"hookEventName": "UserPromptSubmit",
// "additionalContext": "..."}}, which Claude Code adds to the prompt.
//
// Prints nothing, and exits 0, when no page is shared, when the bridge is off
// or unreachable, on any error, and after 900 ms at most, so it can never
// block or fail a prompt.
//
//   node prompt-hook.ts      (Node 22.18+, payload on stdin)

import { connect } from 'node:net';
import { findRecord } from './src/discovery.ts';

const BUDGET_MS = 900;
setTimeout(() => process.exit(0), BUDGET_MS).unref();
process.on('uncaughtException', () => process.exit(0));

async function readStdin(): Promise<string> {
	let data = '';
	for await (const chunk of process.stdin) {
		data += String(chunk);
	}
	return data;
}

/** Sends newline-delimited JSON-RPC and resolves each reply by its id. */
function mcpCall(pipe: string, token: string, messages: object[], lastId: number): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const socket = connect(pipe, () => {
			socket.write(`${token}\n`);
			for (const m of messages) {
				socket.write(`${JSON.stringify(m)}\n`);
			}
		});
		let buffer = '';
		socket.on('data', chunk => {
			buffer += String(chunk);
			let newline: number;
			while ((newline = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				const reply = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
				if (reply.id === lastId) {
					socket.end();
					if (reply.error) {
						reject(new Error(JSON.stringify(reply.error)));
					} else {
						resolve(reply.result);
					}
				}
			}
		});
		socket.on('error', reject);
		socket.on('close', () => reject(new Error('closed')));
	});
}

try {
	const payload = JSON.parse(await readStdin()) as { cwd?: string };
	const record = findRecord(payload.cwd ?? process.cwd());
	if (record) {
		// The SDK server answers requests in order, so the initialize handshake
		// and the call can go out together.
		const result = await mcpCall(record.pipe, record.token, [
			{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vscode-tools-bridge-prompt-hook', version: '0' } } },
			{ jsonrpc: '2.0', method: 'notifications/initialized' },
			{ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'shared_browser_pages', arguments: { snapshot: false } } },
		], 2) as { content?: { type: string; text?: string }[]; isError?: boolean };
		const listing = (result.content ?? []).map(c => c.text ?? '').join('\n');
		if (!result.isError && listing.includes('Page ID:')) {
			const context = [
				'Browser pages the user has shared with you in VS Code\'s integrated browser (this reflects the moment the prompt was sent):',
				'',
				listing,
				'',
				'To see a page, call the vscode-tools MCP server\'s read_page (text snapshot) or screenshot_page with its page ID; shared_browser_pages lists them again with snapshots.',
			].join('\n');
			// Exit only once the write is flushed; stdout may be asynchronous on a pipe.
			process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }), () => process.exit(0));
			await new Promise(() => undefined);
		}
	}
} catch {
	// Any failure means "nothing to add"; the prompt goes ahead unchanged.
}
process.exit(0);
