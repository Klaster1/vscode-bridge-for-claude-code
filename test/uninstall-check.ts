// Offline check of uninstall.ts, which VS Code runs when the extension is uninstalled: run as a
// separate process, as VS Code does, against a throwaway Claude Code config folder and shim
// folder, with a stand-in for the claude CLI that records its calls.
//
//   node test/uninstall-check.ts

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { shimPaths, writeShims } from '../src/shims.ts';
import { check, finish } from './harness.ts';

const root = join(import.meta.dirname, '..');
const temp = mkdtempSync(join(tmpdir(), 'un-'));
const bin = join(temp, 'bin');
mkdirSync(bin);
const claudeLog = join(temp, 'claude.log');
if (process.platform === 'win32') {
	writeFileSync(join(bin, 'claude.cmd'), `@echo %* >> "${claudeLog}"\r\n`);
} else {
	writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho "$@" >> "${claudeLog}"\n`);
	chmodSync(join(bin, 'claude'), 0o755);
}

/** Runs the uninstall script with the config and shim folders in `folder`, and returns where things are. */
function uninstall(folder: string, setup: (paths: { configDir: string; shimDir: string }) => void) {
	const configDir = join(folder, 'claude-config');
	const shimDir = join(folder, 'shims');
	mkdirSync(configDir, { recursive: true });
	const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: configDir, VSCODE_TOOLS_BRIDGE_DIR: shimDir };
	const pathKey = Object.keys(env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';
	env[pathKey] = `${bin}${delimiter}${env[pathKey] ?? ''}`;
	Object.assign(process.env, { CLAUDE_CONFIG_DIR: configDir, VSCODE_TOOLS_BRIDGE_DIR: shimDir });
	writeShims(root, shimDir);
	rmSync(claudeLog, { force: true });
	setup({ configDir, shimDir });
	const result = spawnSync(process.execPath, [join(root, 'uninstall.ts')], { env, encoding: 'utf8', timeout: 20_000 });
	return { configDir, shimDir, result, claudeCalls: existsSync(claudeLog) ? readFileSync(claudeLog, 'utf8').trim() : '' };
}

const hookEntry = (command: string) => ({ hooks: [{ type: 'command', command }] });

await check('the manifest runs the uninstall script as VS Code requires, with node and a file', () => {
	const scripts = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
	assert.match(scripts['vscode:uninstall'] ?? '', /^node \.\/uninstall\.ts$/);
	assert.ok(existsSync(join(root, 'uninstall.ts')));
});

await check('uninstalling removes the shims, the registration and the hook entry the bridge added', () => {
	const run = uninstall(join(temp, 'one'), ({ configDir }) => {
		const shims = shimPaths();
		writeFileSync(join(configDir, '.claude.json'), JSON.stringify({ mcpServers: { 'vscode-tools': { type: 'stdio', command: 'node', args: [shims.launcher], env: {} } } }));
		writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ theme: 'dark', hooks: { UserPromptSubmit: [hookEntry(`node "${shims.hook}"`), hookEntry('echo unrelated')] } }));
	});
	assert.equal(run.result.status, 0, run.result.stderr);
	assert.match(run.claudeCalls, /^mcp remove --scope user vscode-tools/);
	assert.ok(!existsSync(join(run.shimDir, 'launcher.mjs')) && !existsSync(join(run.shimDir, 'prompt-hook.mjs')), 'a shim is left');
	assert.ok(!existsSync(run.shimDir), 'the empty shim folder is left');
	const saved = JSON.parse(readFileSync(join(run.configDir, 'settings.json'), 'utf8')) as { theme: string; hooks: { UserPromptSubmit: { hooks: { command: string }[] }[] } };
	assert.equal(saved.theme, 'dark');
	assert.deepEqual(saved.hooks.UserPromptSubmit.flatMap(e => e.hooks.map(h => h.command)), ['echo unrelated']);
});

await check('uninstalling leaves a vscode-tools server it did not add, other files in the shim folder and the rest of the settings', () => {
	let before = '';
	const run = uninstall(join(temp, 'two'), ({ configDir, shimDir }) => {
		writeFileSync(join(configDir, '.claude.json'), JSON.stringify({ mcpServers: { 'vscode-tools': { type: 'stdio', command: 'node', args: ['/somewhere/else.mjs'], env: {} } } }));
		before = JSON.stringify({ hooks: { UserPromptSubmit: [hookEntry('node "/old/clone/prompt-hook.ts"')] } });
		writeFileSync(join(configDir, 'settings.json'), before);
		writeFileSync(join(shimDir, 'window.json'), '{}');
	});
	assert.equal(run.result.status, 0, run.result.stderr);
	assert.equal(run.claudeCalls, '', 'claude was called');
	assert.equal(readFileSync(join(run.configDir, 'settings.json'), 'utf8'), before);
	assert.ok(existsSync(join(run.shimDir, 'window.json')), 'a file of another window was deleted');
	assert.ok(!existsSync(join(run.shimDir, 'launcher.mjs')));
});

await check('uninstalling with nothing registered exits quietly', () => {
	const run = uninstall(join(temp, 'three'), () => undefined);
	assert.equal(run.result.status, 0);
	assert.equal(run.result.stdout + run.result.stderr, '');
	assert.equal(run.claudeCalls, '');
});

rmSync(temp, { recursive: true, force: true });
finish();
