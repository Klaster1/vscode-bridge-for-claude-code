// The "Connect Claude Code" command: registers the vscode-tools MCP server with Claude Code
// and adds the prompt hook to its settings, both pointing at the fixed shims, so an install
// from a VSIX needs no clone. Also offers the command once, when no server is registered yet.

import * as vscode from 'vscode';
import { connectClaudeCode, readRegistration, serverName, settingsFile } from './install.ts';
import { shimPaths } from './shims.ts';

const connectCommand = 'vscodeToolsBridge.connectClaudeCode';

async function connect(log: vscode.LogOutputChannel): Promise<void> {
	const choice = await vscode.window.showInformationMessage('Connect Claude Code to VS Code?', {
		modal: true,
		detail: `This registers the "${serverName}" MCP server with Claude Code for your user, and adds the prompt hook to ${settingsFile()}. It replaces an earlier registration and an earlier hook entry.`,
	}, 'Connect');
	if (choice !== 'Connect') {
		return;
	}
	const failures = await connectClaudeCode(shimPaths());
	if (failures.length) {
		failures.forEach(f => log.error(f));
		await vscode.window.showErrorMessage(failures.join('\n\n'), { modal: true });
	} else {
		log.info('Connected Claude Code: registered the MCP server and added the prompt hook.');
		void vscode.window.showInformationMessage('Claude Code is connected. Start a new Claude Code session to use the tools.');
	}
}

export function registerConnect(context: vscode.ExtensionContext, log: vscode.LogOutputChannel): void {
	context.subscriptions.push(vscode.commands.registerCommand(connectCommand, () => connect(log).catch(err => log.error(`Connect failed: ${err instanceof Error ? err.message : String(err)}`))));
	// Offered once, when nothing registers the server yet.
	if (!context.globalState.get('connectOffered') && readRegistration() === null) {
		void context.globalState.update('connectOffered', true);
		void vscode.window.showInformationMessage('Connect Claude Code to VS Code to use the bridge\'s tools.', 'Connect Claude Code').then(choice => {
			if (choice) {
				void vscode.commands.executeCommand(connectCommand);
			}
		});
	}
}
