// Test-only stand-in for the Claude Code extension, which the end-to-end test
// cannot install. It has Claude Code's extension ID. Like Claude Code, it posts
// { type: 'from-extension', message: { type, ... } } to a webview whose page
// reports every message it receives, and it opens file links with
// window.showTextDocument(uri) and a vscode.open fallback.
const vscode = require('vscode');

const received = [];
const selections = [];
let panel;
let chat;
let clearsChip = false;
const chatMessages = [];

// Claude Code's chat page as the bridge sees it: the element for start-up errors, a script nonce in the
// content security policy, a meta tag after <head>, and one script that calls acquireVsCodeApi() once.
// Like a React renderer, it keeps each code element and updates its text in place, or swaps the text node.
const chatPage = initialBlocks => {
	const nonce = Buffer.from(String(Math.random()) + String(Date.now())).toString('base64').replace(/[^A-Za-z0-9]/g, '');
	const script = `
const vscode = acquireVsCodeApi();
const root = document.getElementById('root');
const codes = [];
const render = (blocks, replace) => blocks.forEach((block, i) => {
	let code = codes[i];
	if (!code) {
		const pre = document.createElement('pre');
		code = codes[i] = document.createElement('code');
		code.append(document.createTextNode(block.text));
		pre.append(code);
		root.append(pre);
	} else if (replace) {
		code.replaceChildren(document.createTextNode(block.text));
	} else {
		code.firstChild.data = block.text;
	}
	code.className = 'language-' + block.lang;
});
addEventListener('message', e => {
	vscode.postMessage({ kind: 'received', data: e.data });
	const message = e.data && e.data.type === 'from-extension' && e.data.message;
	if (message && message.type === 'render') {
		render(message.blocks, message.replace);
	}
});
render(${JSON.stringify(initialBlocks).replaceAll('<', '\\u003c')}, false);
vscode.postMessage({ kind: 'ready' });`;
	return `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"></head><body><pre id="claude-error"></pre><div id="root"></div><script nonce="${nonce}">${script}</script></body></html>`;
};
const useChat = (webviewPanel, initialBlocks, onReady) => {
	chat = webviewPanel;
	webviewPanel.onDidDispose(() => { chat = chat === webviewPanel ? undefined : chat; });
	webviewPanel.webview.onDidReceiveMessage(m => {
		chatMessages.push(m);
		if (m.kind === 'ready') {
			onReady?.();
		}
	});
	webviewPanel.webview.html = chatPage(initialBlocks);
};

exports.activate = context => {
	// Claude Code restores its chat tab through a serializer for this view type.
	context.subscriptions.push(vscode.window.registerWebviewPanelSerializer('claudeVSCodePanel', {
		deserializeWebviewPanel: async webviewPanel => useChat(webviewPanel, [{ lang: 'typescript', text: 'const restored = 1;' }]),
	}));
	// The start-up race test opens the chat in its first launch with this file, which it removes before the second.
	const [folder] = vscode.workspace.workspaceFolders ?? [];
	if (folder && require('fs').existsSync(require('path').join(folder.uri.fsPath, 'open-chat.flag'))) {
		const opened = vscode.window.createWebviewPanel('claudeVSCodePanel', 'Claude Code stand-in', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true });
		useChat(opened, [{ lang: 'typescript', text: 'const restored = 1;' }]);
	}
	context.subscriptions.push(
		vscode.commands.registerCommand('standin.openChat', () => new Promise(resolve => {
			chat?.dispose();
			chatMessages.length = 0;
			const opened = vscode.window.createWebviewPanel('claudeVSCodePanel', 'Claude Code stand-in', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true });
			useChat(opened, [], () => resolve(true));
		})),
		// Blocks are { lang, text }; with `replace` an existing block gets a new text node.
		vscode.commands.registerCommand('standin.render', async (blocks, replace) => chat?.webview.postMessage({ type: 'from-extension', message: { type: 'render', blocks, replace: !!replace } })),
		vscode.commands.registerCommand('standin.chatReceived', () => chatMessages),
		vscode.commands.registerCommand('standin.closeChat', () => chat?.dispose()),
		// What Claude Code's selection listener for the CLI reads: the editor's document and selection.
		vscode.window.onDidChangeTextEditorSelection(e => selections.push({ uri: e.textEditor.document.uri.fsPath, text: e.textEditor.document.getText(e.textEditor.selection) })),
		vscode.commands.registerCommand('standin.selections', () => selections),
		// Claude Code clears its chip, in the handler of the event itself, when the active text editor goes and no text editor is visible.
		vscode.commands.registerCommand('standin.clearsChip', on => { clearsChip = !!on; }),
		vscode.window.onDidChangeActiveTextEditor(editor => {
			if (clearsChip && !editor && !vscode.window.visibleTextEditors.length) {
				panel?.webview.postMessage({ type: 'from-extension', message: { type: 'request', channelId: '', requestId: '', request: { type: 'selection_changed', selection: undefined } } });
			}
		}),
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
		vscode.commands.registerCommand('standin.setting', key => vscode.workspace.getConfiguration('vscodeBridge').get(key)),
		vscode.commands.registerCommand('standin.groupCount', () => vscode.window.tabGroups.all.length),
		vscode.commands.registerCommand('standin.activeTab', () => {
			const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
			const input = tab?.input;
			return { label: tab?.label, kind: input instanceof vscode.TabInputText ? 'text' : input instanceof vscode.TabInputCustom ? 'custom' : 'other', viewType: input?.viewType, uri: input?.uri?.fsPath };
		}),
	);
};
