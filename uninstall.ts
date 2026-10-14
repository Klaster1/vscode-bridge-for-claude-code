// The extension's "vscode:uninstall" script. VS Code runs it with plain Node, and no VS Code API, when
// the extension is uninstalled, and stops it after 5 seconds. It removes what the extension added
// outside its own folder: the prompt hook and the vscode-tools MCP server in Claude Code's config,
// where they point at the shims, and the shims themselves. VS Code logs what it prints.
//
//   node uninstall.ts      (Node 22.18+)

import { disconnectClaudeCode } from './src/install.ts';
import { removeShims, shimPaths } from './src/shims.ts';

for (const problem of await disconnectClaudeCode(shimPaths())) {
	console.error(problem);
}
removeShims();
