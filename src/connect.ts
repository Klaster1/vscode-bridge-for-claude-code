// The "Connect Claude Code" command: registers the vscode-tools MCP server with Claude Code
// and adds the prompt hook to its settings, both pointing at the fixed shims, so an install
// from a VSIX needs no clone. Also offers the command once, when no server is registered yet.

import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { shimPaths } from './shims.ts';

export const connectCommand = 'vscodeToolsBridge.connectClaudeCode';
const server = 'vscode-tools';

/** Claude Code's config folder: CLAUDE_CONFIG_DIR, as Claude Code reads it, or ~/.claude. */
const settingsFile = (): string => join(process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude'), 'settings.json');
/** The file that lists the user-scope MCP servers. */
const userConfigFile = (): string => process.env['CLAUDE_CONFIG_DIR'] ? join(process.env['CLAUDE_CONFIG_DIR'], '.claude.json') : join(homedir(), '.claude.json');

function runClaude(args: string[]): Promise<{ ok: boolean; output: string }> {
	return new Promise(resolve => {
		// On Windows an npm-installed claude is a .cmd file, which Node starts only through a shell.
		const child = process.platform === 'win32'
			? spawn(['claude', ...args.map(a => /[\s&()^|<>"]/.test(a) ? `"${a}"` : a)].join(' '), { shell: true, windowsHide: true })
			: spawn('claude', args);
		let output = '';
		child.stdout?.on('data', d => { output += String(d); });
		child.stderr?.on('data', d => { output += String(d); });
		const timer = setTimeout(() => child.kill(), 30_000);
		child.on('error', err => { clearTimeout(timer); resolve({ ok: false, output: err.message }); });
		child.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0, output: output.trim() }); });
	});
}

type HookEntry = { hooks?: { type?: string; command?: string; timeout?: number }[] };

/** Puts the hook into Claude Code's settings, replacing any entry that runs prompt-hook. Throws when the file is not plain JSON. */
export function addHook(file: string, command: string): void {
	let settings: { hooks?: { UserPromptSubmit?: HookEntry[] } } = {};
	try {
		settings = JSON.parse(readFileSync(file, 'utf8')) as typeof settings;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw new Error(`${file} is not plain JSON (${err instanceof Error ? err.message : String(err)})`);
		}
	}
	const hooks = (settings.hooks ??= {});
	const kept = (hooks.UserPromptSubmit ?? [])
		.map(entry => ({ ...entry, hooks: (entry.hooks ?? []).filter(h => !/prompt-hook/.test(h.command ?? '')) }))
		.filter(entry => entry.hooks.length);
	hooks.UserPromptSubmit = [...kept, { hooks: [{ type: 'command', command, timeout: 5 }] }];
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}

async function connect(log: vscode.LogOutputChannel): Promise<void> {
	const shims = shimPaths();
	const hookCommand = `node "${shims.hook}"`;
	const choice = await vscode.window.showInformationMessage('Connect Claude Code to VS Code?', {
		modal: true,
		detail: `This registers the "${server}" MCP server with Claude Code for your user, and adds the prompt hook to ${settingsFile()}. It replaces an earlier registration and an earlier hook entry.`,
	}, 'Connect');
	if (choice !== 'Connect') {
		return;
	}
	const failures: string[] = [];
	await runClaude(['mcp', 'remove', '--scope', 'user', server]); // Replaces an earlier registration; fails quietly when there is none.
	const added = await runClaude(['mcp', 'add', '--scope', 'user', server, '--', 'node', shims.launcher]);
	if (!added.ok) {
		failures.push(`Could not register the MCP server (${added.output || 'claude did not run'}). Run: claude mcp add --scope user ${server} -- node "${shims.launcher}"`);
	}
	try {
		addHook(settingsFile(), hookCommand);
	} catch (err) {
		failures.push(`Could not add the prompt hook (${err instanceof Error ? err.message : String(err)}). Add this entry to the "hooks.UserPromptSubmit" array in ${settingsFile()}: ${JSON.stringify({ hooks: [{ type: 'command', command: hookCommand, timeout: 5 }] })}`);
	}
	if (failures.length) {
		failures.forEach(f => log.error(f));
		await vscode.window.showErrorMessage(failures.join('\n\n'), { modal: true });
	} else {
		log.info('Connected Claude Code: registered the MCP server and added the prompt hook.');
		void vscode.window.showInformationMessage('Claude Code is connected. Start a new Claude Code session to use the tools.');
	}
}

/** Whether the user-scope MCP server is registered; undefined when the config cannot be read. */
function isRegistered(): boolean | undefined {
	try {
		const config = JSON.parse(readFileSync(userConfigFile(), 'utf8')) as { mcpServers?: Record<string, unknown> };
		return !!config.mcpServers?.[server];
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'ENOENT' ? false : undefined;
	}
}

export function registerConnect(context: vscode.ExtensionContext, log: vscode.LogOutputChannel): void {
	context.subscriptions.push(vscode.commands.registerCommand(connectCommand, () => connect(log).catch(err => log.error(`Connect failed: ${err instanceof Error ? err.message : String(err)}`))));
	// Offered once, when nothing registers the server yet.
	if (!context.globalState.get('connectOffered') && isRegistered() === false) {
		void context.globalState.update('connectOffered', true);
		void vscode.window.showInformationMessage('Connect Claude Code to VS Code to use the bridge\'s tools.', 'Connect Claude Code').then(choice => {
			if (choice) {
				void vscode.commands.executeCommand(connectCommand);
			}
		});
	}
}
