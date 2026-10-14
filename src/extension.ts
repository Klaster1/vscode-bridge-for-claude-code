// Runs in each VS Code window: serves this window's tools as MCP over a
// private named pipe, and writes a discovery file that lets Claude Code's
// stdio launcher (../launcher.ts) and prompt hook (../prompt-hook.ts) find the
// pipe from their working directory.
// Does nothing while vscodeToolsBridge.enabled is off, or in a window with no
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
import { registerConnect } from './connect.ts';
import { installMarkdownSelection } from './markdownSelection.ts';
import { writeShims } from './shims.ts';
import { allTools } from './tools.ts';

let log: vscode.LogOutputChannel;
const patches = new Map<string, vscode.Disposable>();
let current: { server: NetServer; file: string; record: DiscoveryRecord } | undefined;

export function activate(context: vscode.ExtensionContext): void {
	log = vscode.window.createOutputChannel('VS Code Bridge for Claude Code', { log: true });
	context.subscriptions.push(log, { dispose: stop }, { dispose: () => syncPatches(true) });
	// Opens the Settings editor at one of this extension's settings, for the links in the README. Only `id` counts; other parameters, such as one a redirect adds, are ignored.
	let refusedLogged = false;
	context.subscriptions.push(vscode.window.registerUriHandler({
		handleUri(uri) {
			const id = uri.path === '/settings' ? new URLSearchParams(uri.query).get('id') : null;
			if (id !== null && /^vscodeToolsBridge\.[\w.]+$/.test(id)) {
				void vscode.commands.executeCommand('workbench.action.openSettings', id);
			} else if (!refusedLogged) {
				refusedLogged = true;
				log.warn(`Ignored the link ${uri.toString()}: it is not a vscodeToolsBridge setting.`);
			}
		},
	}));
	// Claude Code's config points at these, so they exist whether or not the bridge is on.
	try {
		const written = writeShims(context.extensionPath);
		if (written.length) {
			log.info(`Wrote ${written.join(' and ')}.`);
		}
	} catch (err) {
		log.error(`Could not write the launcher and hook shims: ${err instanceof Error ? err.message : String(err)}`);
	}
	registerConnect(context, log);
	const restart = () => {
		stop();
		start().catch(err => log.error(`Bridge failed to start: ${err instanceof Error ? err.message : String(err)}`));
	};
	// Install the patches before returning, so a Markdown Editor opened right after activation is covered.
	syncPatches();
	restart();
	// The pipe is keyed on the first folder, so re-key when the folders change.
	context.subscriptions.push(
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			syncPatches();
			restart();
		}),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('vscodeToolsBridge.enabled')) {
				syncPatches();
				restart();
			} else if (patchSettings.some(([setting]) => e.affectsConfiguration(`vscodeToolsBridge.${setting}`))) {
				syncPatches();
			}
		}),
	);
}

const isEnabled = (): boolean => vscode.workspace.getConfiguration('vscodeToolsBridge').get<boolean>('enabled', true)
	&& vscode.workspace.workspaceFolders?.[0]?.uri.scheme === 'file';

/** The runtime patches, each switched by its own setting. */
const patchSettings: [setting: string, install: (report: (message: string) => void) => vscode.Disposable][] = [
	['markdownEditor.selection', installMarkdownSelection],
	['claudeCode.chatLinks', installChatLinks],
];

/** Installs or removes each patch to match its setting; `removeAll` removes them regardless. */
function syncPatches(removeAll = false): void {
	const config = vscode.workspace.getConfiguration('vscodeToolsBridge');
	const enabled = !removeAll && isEnabled();
	for (const [setting, install] of patchSettings) {
		const wanted = enabled && config.get<boolean>(setting, true);
		const installed = patches.get(setting);
		if (wanted && !installed) {
			try {
				patches.set(setting, install(message => log.info(message)));
			} catch (err) {
				log.error(`The ${setting} patch failed to install: ${err instanceof Error ? err.message : String(err)}`);
			}
		} else if (!wanted && installed) {
			installed.dispose();
			patches.delete(setting);
		}
	}
}

export function deactivate(): void {
	syncPatches(true);
	stop();
}

async function start(): Promise<void> {
	if (!vscode.workspace.getConfiguration('vscodeToolsBridge').get<boolean>('enabled', true)) {
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
