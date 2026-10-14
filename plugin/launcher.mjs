// The vscode-tools MCP server that Claude Code starts. Node strips TypeScript types from 22.18 on;
// an older Node fails to load scripts/launcher.ts with "Unknown file extension", which names no cause.
if (!process.features.typescript) {
	process.stderr.write(`vscode-tools-bridge: needs Node 22.18 or later to run its TypeScript files, found ${process.version}.\n`);
	process.exit(1);
}
await import('./scripts/launcher.ts');
