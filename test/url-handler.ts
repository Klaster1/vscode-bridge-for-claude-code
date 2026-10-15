// Keeps the user's vscode:// handler. VS Code registers itself as the handler for its URL
// protocol each time it starts, so a VS Code from .vscode-test/ would take over the links that
// browsers send to the user's own VS Code, such as the redirect after a GitHub sign-in.
// On another platform it does nothing.

import { spawnSync } from 'node:child_process';

const key = 'HKCU\\Software\\Classes\\vscode';
const command = `${key}\\shell\\open\\command`;

/** Reads the handler now, and writes it back when the process exits, also on an error or Ctrl+C. */
export function keepUrlHandler(): void {
	if (process.platform !== 'win32') {
		return;
	}
	const saved = /REG_\w+\s+(.*)/.exec(spawnSync('reg', ['query', command, '/ve'], { encoding: 'utf8' }).stdout ?? '')?.[1]?.trim();
	process.on('exit', () => {
		// With no handler before, the key is the test build's own, so it goes.
		spawnSync('reg', saved ? ['add', command, '/ve', '/d', saved, '/f'] : ['delete', key, '/f'], { stdio: 'ignore' });
	});
	process.once('SIGINT', () => process.exit(130)); // Node's default Ctrl+C exit skips 'exit' listeners.
}
