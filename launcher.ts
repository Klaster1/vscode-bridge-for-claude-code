// Claude Code starts this as a stdio MCP server. It finds the VS Code window
// whose first workspace folder is the working directory (or its nearest
// ancestor that has one), connects to that window's pipe, sends the token, and
// then relays bytes both ways. The MCP protocol itself runs in the extension.
//
// Run with Node 22.18 or later, which strips the TypeScript types:
//   node launcher.ts

import { connect } from 'node:net';
import { findRecord } from './src/discovery.ts';

// Claude Code can start this before the window has activated the extension or
// switched to this folder, so look for the window for a few seconds before giving up.
const FIND_WINDOW_MS = 15_000;
const FIND_RETRY_MS = 500;

const cwd = process.cwd();
let record = findRecord(cwd);
for (let waited = 0; !record && waited < FIND_WINDOW_MS; waited += FIND_RETRY_MS) {
	await new Promise(done => setTimeout(done, FIND_RETRY_MS));
	record = findRecord(cwd);
}
if (!record) {
	process.stderr.write(`vscode-tools-bridge: no VS Code window has ${cwd} or a parent of it as its first workspace folder, or the bridge extension is not running there.\n`);
	process.exit(1);
}

const socket = connect(record.pipe, () => {
	socket.write(`${record.token}\n`);
	process.stdin.pipe(socket);
	socket.pipe(process.stdout);
});
socket.on('error', err => {
	process.stderr.write(`vscode-tools-bridge: cannot reach the VS Code window for ${record.folder} at ${record.pipe}: ${err.message}. Is that window still open?\n`);
	process.exit(1);
});
socket.on('close', () => process.exit(0));
process.stdin.on('end', () => socket.end());
