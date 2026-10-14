// Installs or updates the bridge from this clone: installs the dependencies, builds the
// VSIX, installs it into VS Code and registers the launcher with Claude Code at user
// scope. Then prints the steps it leaves to you, with this clone's paths filled in.
// Run it again after a `git pull`.
//
//   npm run setup      (Node 22.18+)

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { shimPaths, writeShims } from './src/shims.ts';

const root = import.meta.dirname;
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string; publisher: string; version: string };
const extensionId = `${pkg.publisher}.${pkg.name}`;
const vsix = join(root, `${pkg.name}-${pkg.version}.vsix`);
// Claude Code's config points at the shims in a fixed folder, which import the files of the
// extension version VS Code runs. They point at this clone until the extension starts and takes them over.
writeShims(root);
const { launcher, hook } = shimPaths();

function run(command: string, args: string[], quiet = false): boolean {
	const stdio = quiet ? 'ignore' : 'inherit';
	if (!quiet) {
		console.log(`\n> ${[command, ...args].join(' ')}`);
	}
	// On Windows npm, code and an npm-installed claude are .cmd files, which Node starts only through a shell.
	const result = process.platform === 'win32'
		? spawnSync([command, ...args].map(a => /[\s&()^|<>]/.test(a) ? `"${a}"` : a).join(' '), { cwd: root, stdio, shell: true })
		: spawnSync(command, args, { cwd: root, stdio });
	return result.status === 0;
}

const manual: string[] = [];

if (!run('npm', ['ci']) || !run('npm', ['run', 'package'])) {
	console.error('\nThe build failed; nothing was installed.');
	process.exit(1);
}

if (!run('code', ['--install-extension', vsix, '--force'])) {
	manual.push(`Install the extension: run \`code --install-extension "${vsix}" --force\`, or open the Extensions view in VS Code and use "Install from VSIX..." on that file.`);
}

run('claude', ['mcp', 'remove', '--scope', 'user', 'vscode-tools'], true); // Replaces an earlier registration; fails quietly when there is none.
if (!run('claude', ['mcp', 'add', '--scope', 'user', 'vscode-tools', '--', 'node', launcher])) {
	manual.push(`Register the MCP server: run \`claude mcp add --scope user vscode-tools -- node "${launcher}"\`.`);
}

const hookEntry = { hooks: [{ type: 'command', command: `node "${hook}"`, timeout: 5 }] };
const indent = (text: string): string => text.replace(/^/gm, '     ');
manual.push(
	'Reload each open VS Code window (Developer: Reload Window), so it runs the installed version.',
	`Add the prompt hook to ${join(homedir(), '.claude', 'settings.json')}. Add this entry to the "hooks.UserPromptSubmit" array, and create the array if it is missing. If an entry there already runs prompt-hook.ts, replace it:\n\n`
		+ indent(JSON.stringify(hookEntry, null, 2)),
	'Let Claude use the browser without confirmation dialogs. Run Preferences: Configure Runtime Arguments in VS Code, add this line to argv.json and restart VS Code:\n\n'
		+ indent(`"enable-proposed-api": ["${extensionId}"]`),
	'Start a new Claude Code session in the workspace\'s first folder. /mcp lists vscode-tools as connected, and the "VS Code Bridge for Claude Code" output channel in VS Code logs each call.',
);
console.log(`\nWhat is left to do by hand:\n\n${manual.map((step, i) => `${i + 1}. ${step}`).join('\n\n')}\n`);
