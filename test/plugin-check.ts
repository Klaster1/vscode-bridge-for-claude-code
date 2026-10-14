// Offline check of the Claude Code plugin in plugin/: its manifests agree with package.json, the
// server instructions name its skills, and under a Node without type stripping, as an older Node
// is, the launcher names the Node version it needs and the hook exits quietly. CI runs
// `claude plugin validate --strict` on top.
//
//   node test/plugin-check.ts

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serverInstructions } from '../src/instructions.ts';
import { check, finish } from './harness.ts';

const root = join(import.meta.dirname, '..');
const plugin = join(root, 'plugin');
const json = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const pkg = json<{ version: string }>(join(root, 'package.json'));
const manifest = json<{ name: string; version: string; mcpServers: Record<string, { command: string; args: string[] }> }>(join(plugin, '.claude-plugin', 'plugin.json'));
const marketplace = json<{ plugins: { name: string; source: string }[] }>(join(root, '.claude-plugin', 'marketplace.json'));
const hooks = json<{ hooks: Record<string, { hooks: { command: string; args: string[] }[] }[]> }>(join(plugin, 'hooks', 'hooks.json'));
const withoutTypeStripping = (file: string) => spawnSync(process.execPath, ['--no-experimental-strip-types', file], { encoding: 'utf8', input: '{}', timeout: 20_000 });

await check('the plugin has the extension\'s version, so an update of the marketplace updates the plugin', () => {
	assert.equal(manifest.version, pkg.version);
});

await check('the marketplace lists the plugin from plugin/', () => {
	assert.deepEqual(marketplace.plugins.map(p => [p.name, p.source]), [[manifest.name, './plugin']]);
});

await check('the MCP server and the hook run files the plugin has', () => {
	const commands = [manifest.mcpServers['vscode-tools'], hooks.hooks['UserPromptSubmit']?.[0]?.hooks[0]];
	for (const command of commands) {
		assert.equal(command?.command, 'node');
		const file = command.args[0]!.replace('${CLAUDE_PLUGIN_ROOT}', plugin);
		assert.ok(existsSync(file), `${file} is missing`);
	}
});

await check('the server instructions name only skills the plugin has', () => {
	const named = [...serverInstructions.matchAll(new RegExp(`\\b${manifest.name}:([a-z-]+)`, 'g'))].map(m => m[1]!);
	assert.ok(named.length, 'no skill named');
	assert.deepEqual(named.filter(name => !existsSync(join(plugin, 'skills', name, 'SKILL.md'))), []);
});

await check('the launcher says which Node it needs when Node cannot strip types', () => {
	const result = withoutTypeStripping(join(plugin, 'launcher.mjs'));
	assert.equal(result.status, 1);
	assert.match(result.stderr, /needs Node 22\.18 or later[^\n]*found v\d+\./);
});

await check('the hook exits quietly when Node cannot strip types', () => {
	const result = withoutTypeStripping(join(plugin, 'prompt-hook.mjs'));
	assert.equal(result.status, 0);
	assert.equal(result.stdout + result.stderr, '');
});

finish();
