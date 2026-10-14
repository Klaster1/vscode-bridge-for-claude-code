// Connects Claude Code to the bridge, and disconnects it: the vscode-tools MCP server and the
// prompt hook, both pointing at the fixed shims. The Connect Claude Code command, `npm run setup`
// and the uninstall script share it, so all three act the same way.
// Imports nothing from 'vscode', so setup.ts and uninstall.ts can use it too.

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { commandLine } from './shell.ts';

export const serverName = 'vscode-tools';

type Shims = { launcher: string; hook: string };
export type RunClaude = (args: string[]) => Promise<{ ok: boolean; output: string }>;
type ServerEntry = { type?: string; command?: string; args?: string[]; env?: Record<string, string> };
type HookEntry = { hooks?: { type?: string; command?: string; timeout?: number }[] };
type Settings = { hooks?: { UserPromptSubmit?: HookEntry[] } };

/** Claude Code's settings.json, in CLAUDE_CONFIG_DIR or ~/.claude. */
export const settingsFile = (): string => join(process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude'), 'settings.json');
/** The file that lists the user-scope MCP servers. */
const userConfigFile = (): string => process.env['CLAUDE_CONFIG_DIR'] ? join(process.env['CLAUDE_CONFIG_DIR'], '.claude.json') : join(homedir(), '.claude.json');

export function runClaude(args: string[]): Promise<{ ok: boolean; output: string }> {
	return new Promise(resolve => {
		const child = process.platform === 'win32'
			? spawn(commandLine('claude', args), { shell: true, windowsHide: true })
			: spawn('claude', args);
		let output = '';
		child.stdout?.on('data', d => { output += String(d); });
		child.stderr?.on('data', d => { output += String(d); });
		const timer = setTimeout(() => child.kill(), 30_000);
		child.on('error', err => { clearTimeout(timer); resolve({ ok: false, output: err.message }); });
		child.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0, output: output.trim() }); });
	});
}

/** The user-scope vscode-tools entry. Null when there is none, undefined when the config cannot be read. */
export function readRegistration(): ServerEntry | null | undefined {
	try {
		const config = JSON.parse(readFileSync(userConfigFile(), 'utf8')) as { mcpServers?: Record<string, ServerEntry> };
		return config.mcpServers?.[serverName] ?? null;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined;
	}
}

function readSettings(file: string): Settings | undefined {
	try {
		return JSON.parse(readFileSync(file, 'utf8')) as Settings;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return undefined;
		}
		throw new Error(`${file} is not plain JSON (${err instanceof Error ? err.message : String(err)})`);
	}
}

const writeSettings = (file: string, settings: Settings): void => {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
};

/** Puts the hook into Claude Code's settings, replacing any entry that runs prompt-hook. Throws when the file is not plain JSON. */
function addHook(file: string, command: string): void {
	const settings = readSettings(file) ?? {};
	const hooks = (settings.hooks ??= {});
	const kept = (hooks.UserPromptSubmit ?? [])
		.map(entry => ({ ...entry, hooks: (entry.hooks ?? []).filter(h => !/prompt-hook/.test(h.command ?? '')) }))
		.filter(entry => entry.hooks.length);
	hooks.UserPromptSubmit = [...kept, { hooks: [{ type: 'command', command, timeout: 5 }] }];
	writeSettings(file, settings);
}

/** Takes out the hooks that run `hookPath`, and the arrays and objects that leaves empty. Throws when the file is not plain JSON. */
export function removeHook(file: string, hookPath: string): void {
	const settings = readSettings(file);
	const entries = settings?.hooks?.UserPromptSubmit;
	if (!settings?.hooks || !entries) {
		return;
	}
	const ours = (command: string | undefined) => (command ?? '').toLowerCase().includes(hookPath.toLowerCase());
	let changed = false;
	const kept = entries.flatMap(entry => {
		const rest = (entry.hooks ?? []).filter(h => !ours(h.command));
		changed ||= rest.length !== (entry.hooks ?? []).length;
		return rest.length === (entry.hooks ?? []).length ? [entry] : rest.length ? [{ ...entry, hooks: rest }] : [];
	});
	if (!changed) {
		return;
	}
	if (kept.length) {
		settings.hooks.UserPromptSubmit = kept;
	} else {
		delete settings.hooks.UserPromptSubmit;
		if (!Object.keys(settings.hooks).length) {
			delete settings.hooks;
		}
	}
	writeSettings(file, settings);
}

/**
 * Registers the MCP server and adds the prompt hook. Leaves a registration that already runs
 * the shim alone. Replaces another one, and puts it back when the new one fails, so a working
 * registration is never lost. Returns what failed, each with the way to do it by hand.
 */
export async function connectClaudeCode(shims: Shims, run: RunClaude = runClaude): Promise<string[]> {
	const failures: string[] = [];
	const existing = readRegistration();
	if (!existing?.args?.includes(shims.launcher)) {
		const add = ['mcp', 'add', '--scope', 'user', serverName, '--', 'node', shims.launcher];
		const byHand = `Run: claude mcp add --scope user ${serverName} -- node "${shims.launcher}"`;
		const removed = existing ? await run(['mcp', 'remove', '--scope', 'user', serverName]) : undefined;
		if (removed && !removed.ok) {
			failures.push(`Could not replace the earlier MCP server registration (${removed.output || 'claude did not run'}). ${byHand}`);
		} else {
			const added = await run(add);
			if (!added.ok) {
				const restored = existing ? await run(['mcp', 'add-json', '--scope', 'user', serverName, JSON.stringify(existing)]) : undefined;
				const note = !restored ? '' : restored.ok ? ' The earlier registration is back.' : ' The earlier registration could not be put back.';
				failures.push(`Could not register the MCP server (${added.output || 'claude did not run'}).${note} ${byHand}`);
			}
		}
	}
	const hookCommand = `node "${shims.hook}"`;
	try {
		addHook(settingsFile(), hookCommand);
	} catch (err) {
		failures.push(`Could not add the prompt hook (${err instanceof Error ? err.message : String(err)}). Add this entry to the "hooks.UserPromptSubmit" array in ${settingsFile()}: ${JSON.stringify({ hooks: [{ type: 'command', command: hookCommand, timeout: 5 }] })}`);
	}
	return failures;
}

/** Undoes connectClaudeCode: removes the hook and the registration only where they point at the shims. Returns what failed. */
export async function disconnectClaudeCode(shims: Shims, run: RunClaude = runClaude): Promise<string[]> {
	const problems: string[] = [];
	try {
		removeHook(settingsFile(), shims.hook);
	} catch (err) {
		problems.push(`Could not remove the prompt hook: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (readRegistration()?.args?.includes(shims.launcher)) {
		const removed = await run(['mcp', 'remove', '--scope', 'user', serverName]);
		if (!removed.ok) {
			problems.push(`Could not remove the MCP server (${removed.output || 'claude did not run'}).`);
		}
	}
	return problems;
}
