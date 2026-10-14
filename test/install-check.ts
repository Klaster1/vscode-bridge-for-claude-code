// Offline check of src/install.ts, which `npm run setup` and the Connect Claude Code command share:
// what it registers in a throwaway Claude Code config folder, with the `claude` calls recorded
// instead of run.
//
//   node test/install-check.ts

import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectClaudeCode, serverName, settingsFile, type RunClaude } from '../src/install.ts';
import { check, finish } from './harness.ts';

const temp = mkdtempSync(join(tmpdir(), 'ic-'));
const shims = { launcher: 'C:/shims/launcher.mjs', hook: 'C:/shims/prompt-hook.mjs' };
const hookCommand = `node "${shims.hook}"`;
const stdio = (command: string, ...args: string[]) => ({ type: 'stdio', command, args, env: {} });

/** A fresh config folder holding the given files, which the install code finds through CLAUDE_CONFIG_DIR. */
function config(files: { servers?: Record<string, unknown>; settings?: unknown; settingsText?: string }): string {
	const dir = mkdtempSync(join(temp, 'c-'));
	process.env['CLAUDE_CONFIG_DIR'] = dir;
	if (files.servers) {
		writeFileSync(join(dir, '.claude.json'), JSON.stringify({ mcpServers: files.servers }));
	}
	if (files.settings !== undefined || files.settingsText !== undefined) {
		writeFileSync(join(dir, 'settings.json'), files.settingsText ?? JSON.stringify(files.settings));
	}
	return dir;
}

/** A stand-in for the claude CLI that records each call and fails the sub-commands named in `failing`. */
function fakeClaude(failing: string[] = []) {
	const calls: string[][] = [];
	const run: RunClaude = async args => {
		calls.push(args);
		return failing.includes(args[1]!) ? { ok: false, output: `${args[1]} failed` } : { ok: true, output: '' };
	};
	return { calls, run, subcommands: () => calls.map(c => c[1]).join() };
}

const hookEntry = (command: string) => ({ hooks: [{ type: 'command', command }] });
const commandsIn = (dir: string): string[] =>
	(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as { hooks?: { UserPromptSubmit?: { hooks: { command: string }[] }[] } })
		.hooks?.UserPromptSubmit?.flatMap(e => e.hooks.map(h => h.command)) ?? [];

await check('the hook goes into the settings file of CLAUDE_CONFIG_DIR, and the server is added once', async () => {
	const dir = config({});
	const claude = fakeClaude();
	assert.deepEqual(await connectClaudeCode(shims, claude.run), []);
	assert.equal(claude.subcommands(), 'add');
	assert.equal(settingsFile(), join(dir, 'settings.json'));
	assert.deepEqual(commandsIn(dir), [hookCommand]);
});

await check('a registration that already runs the shim is left alone, and the hook is not doubled', async () => {
	const dir = config({ servers: { [serverName]: stdio('node', shims.launcher) }, settings: { theme: 'dark', hooks: { UserPromptSubmit: [hookEntry(hookCommand)] } } });
	const claude = fakeClaude();
	assert.deepEqual(await connectClaudeCode(shims, claude.run), []);
	assert.deepEqual(claude.calls, [], 'claude was called');
	assert.deepEqual(commandsIn(dir), [hookCommand]);
	assert.equal((JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as { theme: string }).theme, 'dark');
});

await check('another registration is replaced, and an old prompt-hook entry too', async () => {
	const dir = config({ servers: { [serverName]: stdio('node', '/old/clone/launcher.ts') }, settings: { hooks: { UserPromptSubmit: [hookEntry('node "/old/clone/prompt-hook.ts"'), hookEntry('echo unrelated')] } } });
	const claude = fakeClaude();
	assert.deepEqual(await connectClaudeCode(shims, claude.run), []);
	assert.equal(claude.subcommands(), 'remove,add');
	assert.deepEqual(commandsIn(dir), ['echo unrelated', hookCommand]);
});

await check('when the new registration fails, the earlier one is put back', async () => {
	const earlier = stdio('node', '/old/clone/launcher.ts');
	config({ servers: { [serverName]: earlier } });
	const claude = fakeClaude(['add']);
	const failures = await connectClaudeCode(shims, claude.run);
	assert.equal(claude.subcommands(), 'remove,add,add-json');
	assert.equal(claude.calls[2]!.at(-1), JSON.stringify(earlier));
	assert.equal(failures.length, 1);
	assert.match(failures[0]!, /The earlier registration is back\. Run: claude mcp add --scope user vscode-tools -- node "C:\/shims\/launcher\.mjs"/);
});

await check('when the earlier registration cannot be removed, nothing is added', async () => {
	config({ servers: { [serverName]: stdio('node', '/old/clone/launcher.ts') } });
	const claude = fakeClaude(['remove']);
	const failures = await connectClaudeCode(shims, claude.run);
	assert.equal(claude.subcommands(), 'remove');
	assert.match(failures[0] ?? '', /Could not replace the earlier MCP server registration/);
});

await check('a settings file that is not JSON is reported with the entry to add by hand', async () => {
	config({ settingsText: '// comment\n{}' });
	const failures = await connectClaudeCode(shims, fakeClaude().run);
	assert.equal(failures.length, 1);
	assert.match(failures[0]!, /Could not add the prompt hook[\s\S]*prompt-hook\.mjs/);
});

rmSync(temp, { recursive: true, force: true });
finish();
