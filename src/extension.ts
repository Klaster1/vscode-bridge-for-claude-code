// Runs in each VS Code window: serves this window's tools as MCP over a
// private named pipe, and writes a discovery file that lets Claude Code's
// stdio launcher (../launcher.ts) and prompt hook (../prompt-hook.ts) find the
// pipe from their working directory.
// Does nothing until vscodeToolsBridge.enabled is on, or in a window with no
// folder open. That includes the runtime patches of other extensions.

import * as vscode from 'vscode';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { discoveryDir, discoveryFile, folderHash, type DiscoveryRecord } from './discovery.ts';
import { installChatLinks } from './chatLinks.ts';
import { installMarkdownSelection } from './markdownSelection.ts';
import { allTools } from './tools.ts';

let log: vscode.LogOutputChannel;
let patches: vscode.Disposable[] | undefined;
let current: { server: NetServer; file: string; record: DiscoveryRecord } | undefined;

export function activate(context: vscode.ExtensionContext): void {
	log = vscode.window.createOutputChannel('VS Code Tools Bridge', { log: true });
	context.subscriptions.push(log, { dispose: stop }, { dispose: () => syncPatches(false) });
	const restart = () => {
		stop();
		start().catch(err => log.error(`Bridge failed to start: ${err instanceof Error ? err.message : String(err)}`));
	};
	// Install the patch before returning, so a Markdown Editor opened right after activation is covered.
	syncPatches(isEnabled());
	restart();
	// The pipe is keyed on the first folder, so re-key when the folders change.
	context.subscriptions.push(
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			syncPatches(isEnabled());
			restart();
		}),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('vscodeToolsBridge.enabled')) {
				syncPatches(isEnabled());
				restart();
			}
		}),
	);
}

const isEnabled = (): boolean => vscode.workspace.getConfiguration('vscodeToolsBridge').get<boolean>('enabled', false)
	&& vscode.workspace.workspaceFolders?.[0]?.uri.scheme === 'file';

/** Installs or removes the runtime patches: the Markdown Editor selection and the chat links. */
function syncPatches(wanted: boolean): void {
	if (wanted && !patches) {
		const report = (message: string) => log.info(message);
		patches = [installMarkdownSelection, installChatLinks].flatMap(install => {
			try {
				return [install(report)];
			} catch (err) {
				log.error(`A runtime patch failed to install: ${err instanceof Error ? err.message : String(err)}`);
				return [];
			}
		});
	} else if (!wanted && patches) {
		patches.forEach(p => p.dispose());
		patches = undefined;
	}
}

export function deactivate(): void {
	syncPatches(false);
	stop();
}

async function start(): Promise<void> {
	if (!vscode.workspace.getConfiguration('vscodeToolsBridge').get<boolean>('enabled', false)) {
		log.info('vscodeToolsBridge.enabled is off; bridge not started.');
		return;
	}
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder || folder.uri.scheme !== 'file') {
		log.info('No local workspace folder; bridge not started.');
		return;
	}
	const hash = folderHash(folder.uri.fsPath);
	const suffix = randomBytes(8).toString('hex');
	const record: DiscoveryRecord = {
		pipe: process.platform === 'win32'
			? `\\\\.\\pipe\\vscode-tools-bridge-${hash}-${suffix}`
			: join(discoveryDir(), `${hash}-${suffix}.sock`),
		token: randomBytes(32).toString('hex'),
		folder: folder.uri.fsPath,
		pid: process.pid,
	};
	const server = createServer(socket => handleConnection(socket, record.token));
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(record.pipe, resolve);
	});
	const file = discoveryFile(folder.uri.fsPath);
	mkdirSync(discoveryDir(), { recursive: true, mode: 0o700 });
	// A second window on the same first folder takes over the file; the
	// earlier window keeps its pipe but is no longer found.
	writeFileSync(file, JSON.stringify(record, null, 2), { mode: 0o600 });
	current = { server, file, record };
	log.info(`Listening on ${record.pipe} for ${record.folder} (discovery file ${file})`);
}

function stop(): void {
	if (!current) {
		return;
	}
	const { server, file, record } = current;
	current = undefined;
	server.close();
	try {
		// Remove the file only if another window has not taken it over.
		if ((JSON.parse(readFileSync(file, 'utf8')) as DiscoveryRecord).token === record.token) {
			rmSync(file);
		}
	} catch {
		// Already gone.
	}
}

/**
 * The first line on a connection must be the token from the discovery file;
 * anything else closes the connection. The rest of the stream is MCP
 * (newline-delimited JSON-RPC), served by a fresh MCP server per connection.
 */
function handleConnection(socket: Socket, token: string): void {
	let buffered = Buffer.alloc(0);
	const expected = Buffer.from(token);
	const onData = (chunk: Buffer) => {
		buffered = Buffer.concat([buffered, chunk]);
		const newline = buffered.indexOf(0x0a);
		if (newline < 0) {
			if (buffered.length > 256) {
				socket.destroy();
			}
			return;
		}
		socket.off('data', onData);
		const offered = buffered.subarray(0, newline);
		if (offered.length !== expected.length || !timingSafeEqual(offered, expected)) {
			log.warn('Rejected a connection with a wrong token.');
			socket.destroy();
			return;
		}
		const input = new PassThrough();
		input.write(buffered.subarray(newline + 1));
		socket.pipe(input);
		void serveMcp(input, socket);
	};
	socket.on('data', onData);
	socket.on('error', err => log.debug(`Connection error: ${err.message}`));
}

async function serveMcp(input: PassThrough, socket: Socket): Promise<void> {
	const version = String((vscode.extensions.getExtension('local.vscode-tools-bridge')?.packageJSON as { version?: string } | undefined)?.version ?? '0.0.0');
	const server = new Server({ name: 'vscode-tools-bridge', version }, { capabilities: { tools: {} } });
	const info = () => ({
		...(current ? { folder: current.record.folder, pipe: current.record.pipe, discoveryFile: current.file } : {}),
		// Shows the extension host runs this .ts source through Node type stripping.
		node: process.version,
		typeStripping: (process.features as { typescript?: string }).typescript ?? null,
		loadedFrom: import.meta.filename,
	});
	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allTools(info).map(t => t.definition) }));
	server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		const tool = allTools(info).find(t => t.definition.name === request.params.name);
		if (!tool) {
			return { content: [{ type: 'text', text: `Unknown tool ${request.params.name}` }], isError: true };
		}
		const cancel = new vscode.CancellationTokenSource();
		extra.signal.addEventListener('abort', () => cancel.cancel());
		const started = Date.now();
		try {
			const result = await tool.call(request.params.arguments ?? {}, cancel.token);
			log.info(`${request.params.name} ok in ${Date.now() - started} ms`);
			return result;
		} catch (err) {
			log.warn(`${request.params.name} failed: ${err instanceof Error ? err.message : String(err)}`);
			return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
		} finally {
			cancel.dispose();
		}
	});
	socket.on('close', () => void server.close());
	await server.connect(new StdioServerTransport(input, socket));
}
