// The two small files Claude Code's config points at: a launcher for the MCP server and the
// prompt hook. Each only imports the matching file of the extension version that wrote it,
// so the config keeps one fixed path while the extension's own folder changes with each version.
// Imports nothing from 'vscode', so setup.ts can use it too.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoveryDir } from './discovery.ts';

/**
 * Where the shims live. On Windows that is the discovery folder. Elsewhere the discovery
 * folder is under ~/.cache, which cleaners may empty, and the shims must stay where Claude
 * Code's config says, so they go under ~/.local/share.
 */
export function shimDir(): string {
	return process.platform === 'win32' || process.env['VSCODE_TOOLS_BRIDGE_DIR']
		? discoveryDir()
		: join(homedir(), '.local', 'share', 'vscode-tools-bridge');
}

const files = { launcher: 'launcher.mjs', hook: 'prompt-hook.mjs' } as const;

// Without type stripping, which is on from Node 22.18, Node fails to load the launcher's .ts files with "Unknown file extension", which says nothing about the cause.
const nodeGuard = `if (!process.features.typescript) {
	process.stderr.write(\`vscode-tools-bridge: needs Node 22.18 or later to run its TypeScript files, found \${process.version}.\\n\`);
	process.exit(1);
}
`;

/** The shim paths with forward slashes, which Node accepts on every platform and which need no escaping in JSON or a shell. */
export function shimPaths(dir = shimDir()): { launcher: string; hook: string } {
	const slashed = (file: string): string => join(dir, file).replaceAll('\\', '/');
	return { launcher: slashed(files.launcher), hook: slashed(files.hook) };
}

/** A failed import must not break a prompt, so the hook shim exits quietly. */
function shimContent(target: string, onFailure: string, guard = ''): string {
	return `// Written by VS Code Bridge for Claude Code. It loads ${target.replaceAll('\\', '/')}, and the extension rewrites it at every start. Do not edit.
${guard}try {
	await import(${JSON.stringify(pathToFileURL(target).href)});
} catch (err) {
	${onFailure}
}
`;
}

/** Writes both shims for the extension (or clone) at `root`, each only when its content changes. Returns the files it wrote. */
export function writeShims(root: string, dir = shimDir()): string[] {
	const wanted: [string, string][] = [
		[files.launcher, shimContent(join(root, 'launcher.ts'), "process.stderr.write(`vscode-tools-bridge: could not load the launcher: ${err}\\n`);\n\tprocess.exit(1);", nodeGuard)],
		[files.hook, shimContent(join(root, 'prompt-hook.ts'), 'process.exit(0);')],
	];
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const written: string[] = [];
	for (const [name, content] of wanted) {
		let current: string | undefined;
		try {
			current = readFileSync(join(dir, name), 'utf8');
		} catch {
			// Missing: written below.
		}
		if (current !== content) {
			writeFileSync(join(dir, name), content);
			written.push(name);
		}
	}
	return written;
}
