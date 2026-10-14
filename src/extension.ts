// Runs in each VS Code window: serves this window's tools as MCP over a
// private named pipe, and writes a discovery file that lets Claude Code's
// stdio launcher (../launcher.ts) and prompt hook (../prompt-hook.ts) find the
// pipe from their working directory.
// Does nothing while vscodeToolsBridge.enabled is off, or in a window with no
// folder open. That includes the runtime patches of other extensions.

import * as vscode from 'vscode';
import type { Socket } from 'node:net';
import type { PassThrough } from 'node:stream';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createBridgeListener } from './bridgeServer.ts';
import { installChatLinks } from './chatLinks.ts';
import { registerConnect } from './connect.ts';
import { serverInstructions } from './instructions.ts';
import { installMarkdownSelection } from './markdownSelection.ts';
import { writeShims } from './shims.ts';
import { allTools } from './tools.ts';

let log: vscode.LogOutputChannel;
const patches = new Map<string, vscode.Disposable>();
const bridge = createBridgeListener({
	serve: (input, socket) => void serveMcp(input, socket),
	warn: message => log.warn(message),
	debug: message => log.debug(message),
});

export function activate(context: vscode.ExtensionContext): void {
	log = vscode.window.createOutputChannel('VS Code Bridge for Claude Code', { log: true });
	context.subscriptions.push(log, { dispose: bridge.stop }, { dispose: () => syncPatches(true) });
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
		bridge.stop();
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
	bridge.stop();
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
	const listening = await bridge.start(folder.uri.fsPath);
	if (listening) {
		log.info(`Listening on ${listening.record.pipe} for ${listening.record.folder} (discovery file ${listening.file})`);
	}
}

async function serveMcp(input: PassThrough, socket: Socket): Promise<void> {
	const version = String((vscode.extensions.getExtension('local.vscode-tools-bridge')?.packageJSON as { version?: string } | undefined)?.version ?? '0.0.0');
	const server = new Server({ name: 'vscode-tools-bridge', version }, { capabilities: { tools: {} }, instructions: serverInstructions });
	const info = () => ({
		...(bridge.current ? { folder: bridge.current.record.folder, pipe: bridge.current.record.pipe, discoveryFile: bridge.current.file } : {}),
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
