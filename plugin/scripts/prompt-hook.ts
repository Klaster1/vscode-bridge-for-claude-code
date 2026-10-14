// Claude Code UserPromptSubmit hook: tells Claude what the user has in view in
// the VS Code window of this session and Claude Code itself does not report:
// integrated-browser pages shared with the agent, image files open in an editor
// group, and text selected in the Markdown Editor unless it already reached the
// Claude Code surface that runs this session (its selection chip, or the CLI).
// It runs before each prompt is sent.
//
// Reads the hook payload from stdin (JSON with the session's `cwd`), finds that
// window's bridge the same way launcher.ts does, asks it over MCP for
// shared_browser_pages without snapshots, for visible_images and for
// markdown_editor_selection, and prints
// {"hookSpecificOutput": {"hookEventName": "UserPromptSubmit",
// "additionalContext": "..."}}, which Claude Code adds to the prompt. A hook
// adds text only, so an image goes in as its path for Claude to read.
//
// Prints nothing, and exits 0, when there is nothing to report, when the bridge
// is off or unreachable, on any error, and after 900 ms at most, so it can never
// block or fail a prompt.
//
//   node prompt-hook.ts      (Node 22.18+, payload on stdin)

import { connect } from 'node:net';
import { findRecord } from './discovery.ts';

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

type ToolResult = { content?: { type: string; text?: string }[]; isError?: boolean };

/**
 * Sends newline-delimited JSON-RPC and resolves with each reply's result by
 * its id, once every id in `ids` has a reply. An error reply maps to undefined.
 */
function mcpCall(pipe: string, token: string, messages: object[], ids: number[]): Promise<Map<number, ToolResult | undefined>> {
	return new Promise((resolve, reject) => {
		const socket = connect(pipe, () => {
			socket.write(`${token}\n`);
			for (const m of messages) {
				socket.write(`${JSON.stringify(m)}\n`);
			}
		});
		const results = new Map<number, ToolResult | undefined>();
		let buffer = '';
		socket.on('data', chunk => {
			buffer += String(chunk);
			let newline: number;
			while ((newline = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				const reply = JSON.parse(line) as { id?: number; result?: ToolResult; error?: unknown };
				if (reply.id !== undefined && ids.includes(reply.id)) {
					results.set(reply.id, reply.error ? undefined : reply.result);
					if (ids.every(id => results.has(id))) {
						socket.end();
						resolve(results);
					}
				}
			}
		});
		socket.on('error', reject);
		socket.on('close', () => reject(new Error('closed')));
	});
}

const textOf = (result: ToolResult | undefined): string =>
	result && !result.isError ? (result.content ?? []).map(c => c.text ?? '').join('\n') : '';

// Where this prompt goes: Claude Code's chat panel shows a selection in its chip, and the CLI
// connected through /ide gets it from VS Code. A CLI outside a VS Code terminal may not be
// connected, so only one that has VS Code's port variable counts as served; the others get the note.
const surface = process.env['CLAUDE_CODE_ENTRYPOINT'] === 'claude-vscode' ? 'chip'
	: process.env['CLAUDE_CODE_ENTRYPOINT'] === 'cli' && process.env['CLAUDE_CODE_SSE_PORT'] ? 'cli' : undefined;

try {
	const payload = JSON.parse(await readStdin()) as { cwd?: string };
	const record = findRecord(payload.cwd ?? process.cwd());
	if (record) {
		// The SDK server answers requests in order, so the initialize handshake
		// and the calls can go out together.
		const results = await mcpCall(record.pipe, record.token, [
			{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vscode-bridge-for-claude-code-prompt-hook', version: '0' } } },
			{ jsonrpc: '2.0', method: 'notifications/initialized' },
			{ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'shared_browser_pages', arguments: { snapshot: false } } },
			{ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'visible_images', arguments: {} } },
			{ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'markdown_editor_selection', arguments: { selectedOnly: true, ...(surface ? { skipDeliveredTo: surface } : {}) } } },
		], [2, 3, 4]);
		const sections: string[] = [];
		const pages = textOf(results.get(2));
		if (pages.includes('Page ID:')) {
			sections.push([
				'Browser pages the user has shared with you in VS Code\'s integrated browser (this reflects the moment the prompt was sent):',
				'',
				pages,
				'',
				'To see a page, call the vscode-tools MCP server\'s read_page (text snapshot) or screenshot_page with its page ID; shared_browser_pages lists them again with snapshots.',
			].join('\n'));
		}
		const images = textOf(results.get(3));
		if (images.startsWith('- ')) {
			sections.push([
				'Image files the user has on screen in VS Code, one per editor group (this reflects the moment the prompt was sent):',
				'',
				images,
				'',
				'To see an image, read its file with the Read tool.',
			].join('\n'));
		}
		const selections = textOf(results.get(4));
		if (selections.startsWith('- ')) {
			sections.push([
				'Text the user has selected in VS Code\'s Markdown Editor, one entry per editor group (this reflects the moment the prompt was sent):',
				'',
				selections,
				'',
				'To see the text around a selection, read the file with the Read tool. The file on disk lacks any unsaved edits.',
			].join('\n'));
		}
		if (sections.length) {
			const context = sections.join('\n\n');
			// Exit only once the write is flushed; stdout may be asynchronous on a pipe.
			process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }), () => process.exit(0));
			await new Promise(() => undefined);
		}
	}
} catch {
	// Any failure means "nothing to add"; the prompt goes ahead unchanged.
}
process.exit(0);
