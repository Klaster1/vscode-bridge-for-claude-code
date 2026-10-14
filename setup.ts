// Installs or updates the bridge from this clone: installs the dependencies, builds the
// VSIX, installs it into VS Code and connects Claude Code, as the Connect Claude Code command
// does. Then prints the steps it leaves to you, with this clone's paths filled in.
// Run it again after a `git pull`.
//
//   npm run setup      (Node 22.18+)

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectClaudeCode } from './src/install.ts';
import { commandLine } from './src/shell.ts';
import { shimPaths, writeShims } from './src/shims.ts';

const root = import.meta.dirname;
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string; publisher: string; version: string };
const extensionId = `${pkg.publisher}.${pkg.name}`;
const vsix = join(root, `${pkg.name}-${pkg.version}.vsix`);
// Claude Code's config points at the shims in a fixed folder, which import the files of the
// extension version VS Code runs. They point at this clone until the extension starts and takes them over.
writeShims(root);

function run(command: string, args: string[]): boolean {
	console.log(`\n> ${[command, ...args].join(' ')}`);
	const result = process.platform === 'win32'
		? spawnSync(commandLine(command, args), { cwd: root, stdio: 'inherit', shell: true })
		: spawnSync(command, args, { cwd: root, stdio: 'inherit' });
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

console.log('\n> connect Claude Code: register the vscode-tools MCP server and add the prompt hook');
manual.push(...await connectClaudeCode(shimPaths()));

const indent = (text: string): string => text.replace(/^/gm, '     ');
manual.push(
	'Reload each open VS Code window (Developer: Reload Window), so it runs the installed version. Skip this if you restart VS Code in the next step.',
	'Let Claude use the browser without confirmation dialogs. Run Preferences: Configure Runtime Arguments in VS Code, add this line to argv.json and restart VS Code:\n\n'
		+ indent(`"enable-proposed-api": ["${extensionId}"]`),
	'Start a new Claude Code session in the workspace\'s first folder or a folder below it. /mcp lists vscode-tools as connected, and the "VS Code Bridge for Claude Code" output channel in VS Code logs each call.',
);
console.log(`\nWhat is left to do by hand:\n\n${manual.map((step, i) => `${i + 1}. ${step}`).join('\n\n')}\n`);
