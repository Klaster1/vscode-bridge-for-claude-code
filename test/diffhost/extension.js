// Test-only extension that shows SemanticDiff's diff page in an editor tab of its own, as another
// extension can: it hands SemanticDiff its own webview panel when SemanticDiff creates one. With
// `early`, it also gives the panel's webview its own `html` property that calls the prototype
// setter it found at that moment, as an extension that took the setter before the bridge started.
const vscode = require('vscode');
const Module = require('module');
const path = require('path');

let pending;

exports.activate = context => {
	const semanticDiff = vscode.extensions.getExtension('semanticdiff.semanticdiff');
	// The extension host gives each extension its own `vscode` object, chosen by the requiring file's folder.
	const api = Module._load('vscode', { filename: path.join(semanticDiff.extensionPath, 'out', 'extension', 'main.js') }, false);
	const create = api.window.createWebviewPanel;
	api.window.createWebviewPanel = function (viewType, title, showOptions, options) {
		if (viewType !== 'SemanticDiff' || !pending) {
			return create.apply(this, arguments);
		}
		const panel = pending;
		pending = undefined;
		panel.webview.options = { ...panel.webview.options, ...options };
		return panel;
	};
	context.subscriptions.push(vscode.commands.registerCommand('diffhost.prepare', early => {
		pending = vscode.window.createWebviewPanel('diffhost', 'Hosted diff', { viewColumn: vscode.ViewColumn.Active, preserveFocus: true }, { enableScripts: true });
		if (early) {
			const webview = pending.webview;
			let owner = Object.getPrototypeOf(webview);
			while (owner && !Object.getOwnPropertyDescriptor(owner, 'html')) {
				owner = Object.getPrototypeOf(owner);
			}
			const html = Object.getOwnPropertyDescriptor(owner, 'html');
			Object.defineProperty(webview, 'html', { configurable: true, get: () => html.get.call(webview), set: value => html.set.call(webview, value) });
		}
	}));
};
