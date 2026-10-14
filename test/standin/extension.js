// Test-only stand-in for the Claude Code extension, which the end-to-end test
// cannot install. It has Claude Code's extension ID. Like Claude Code, it posts
// { type: 'from-extension', message: { type, ... } } to a webview whose page
// reports every message it receives, and it opens file links with
// window.showTextDocument(uri) and a vscode.open fallback.
const vscode = require('vscode');

const received = [];
const selections = [];
let panel;

exports.activate = context => {
	context.subscriptions.push(
		// What Claude Code's selection listener for the CLI reads: the editor's document and selection.
		vscode.window.onDidChangeTextEditorSelection(e => selections.push({ uri: e.textEditor.document.uri.fsPath, text: e.textEditor.document.getText(e.textEditor.selection) })),
		vscode.commands.registerCommand('standin.selections', () => selections),
		vscode.commands.registerCommand('standin.open', () => {
			panel = vscode.window.createWebviewPanel('standin', 'Claude Code stand-in', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true });
			panel.webview.onDidReceiveMessage(m => {
				if (m.kind === 'ready') {
					// A message the page can only get once it is live, so the bridge sees a delivered post.
					panel.webview.postMessage({ type: 'from-extension', message: { type: 'request', channelId: '', requestId: '', request: { type: 'focus_input' } } });
				} else {
					received.push(m.data);
				}
			});
			panel.webview.html = '<script>const vscode = acquireVsCodeApi(); addEventListener("message", e => vscode.postMessage({ kind: "received", data: e.data })); vscode.postMessage({ kind: "ready" });</script>';
		}),
		vscode.commands.registerCommand('standin.received', () => received),
		vscode.commands.registerCommand('standin.close', () => panel?.dispose()),
		// Claude Code's chat-link handler, reduced to the calls that matter; resolves with the path that opened the file.
		vscode.commands.registerCommand('standin.openLink', uri => new Promise(resolve => {
			const options = { preview: false };
			vscode.window.showTextDocument(uri, options).then(
				() => resolve('showTextDocument'),
				() => vscode.commands.executeCommand('vscode.open', uri, options).then(() => resolve('vscode.open'), err => resolve(`failed: ${err}`)));
		})),
		// Claude Code's other calls pass a TextDocument.
		vscode.commands.registerCommand('standin.showDocument', async uri => {
			try {
				await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
				return 'shown';
			} catch (err) {
				return `rejected: ${err}`;
			}
		}),
		vscode.commands.registerCommand('standin.setting', key => vscode.workspace.getConfiguration('vscodeToolsBridge').get(key)),
		vscode.commands.registerCommand('standin.groupCount', () => vscode.window.tabGroups.all.length),
		vscode.commands.registerCommand('standin.activeTab', () => {
			const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
			const input = tab?.input;
			return { label: tab?.label, kind: input instanceof vscode.TabInputText ? 'text' : input instanceof vscode.TabInputCustom ? 'custom' : 'other', viewType: input?.viewType, uri: input?.uri?.fsPath };
		}),
	);
};
