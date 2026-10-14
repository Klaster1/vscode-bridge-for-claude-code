// Imports nothing from 'vscode'.

/** One command line for a shell on Windows, where npm, code and an npm-installed claude are .cmd files that Node starts only through a shell. */
export function commandLine(command: string, args: string[]): string {
	return [command, ...args].map(a => a === '' || /[\s&()^|<>"]/.test(a) ? `"${a.replaceAll('"', '\\"')}"` : a).join(' ');
}
