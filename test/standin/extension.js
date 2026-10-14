// Test-only stand-in for the Claude Code extension's chat webview, which the
// end-to-end test cannot install. Like Claude Code, it posts
// { type: 'from-extension', message: { type, ... } } to a webview, and its page
// reports every message it receives.
const vscode = require('vscode');

const received = [];
let panel;

exports.activate = context => {
	context.subscriptions.push(
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
	);
};
