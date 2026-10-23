// Reads the selection in VS Code's rich Markdown Editor (the custom editor vscode.markdown.editor).
// The Markdown extension implements the proposed customTextEditorNavigation API for the editor:
// VS Code calls resolveCustomTextEditorNavigation(document, panel) on its provider for each
// editor, and the controller it returns reports the selection as a Selection in the document.
// No other extension can read the controller, so this wraps registerCustomEditorProvider on the
// Markdown extension's own API object and the provider's method, and listens to each controller.
// The Markdown extension must register after the wrap, so an editor that opened before it is not
// read until the window reloads.

import * as vscode from 'vscode';
import { extensionApi } from './extensionApi.ts';
import { deliver, delivered, reporter, type Delivered } from './webviewSelection.ts';

const viewType = 'vscode.markdown.editor';
const markdownExtensionId = 'vscode.markdown-language-features';

/** The controller of the proposed API, as far as this reads it. */
interface Navigation {
	readonly selection: vscode.Selection | undefined;
	readonly onDidChangeSelection: vscode.Event<vscode.Selection | undefined>;
}

interface Provider {
	resolveCustomTextEditorNavigation?(document: vscode.TextDocument, panel: vscode.WebviewPanel, token: vscode.CancellationToken): Navigation | PromiseLike<Navigation>;
}

interface Editor {
	document: vscode.TextDocument;
	listener: vscode.Disposable;
	/** Undefined when the editor has no selection, as after a click outside its text. */
	selection: vscode.Selection | undefined;
	/** Orders editors that show the same file: the newest one's selection wins. */
	updated: number;
}

interface MarkdownEditorState {
	uri: vscode.Uri;
	active: boolean;
	/** Absent when the editor has no selection or was not read. Lines are 1-based; an empty `text` means a cursor. */
	selection?: { startLine: number; endLine: number; text: string };
	delivered: Delivered;
}

const editors = new Map<vscode.WebviewPanel, Editor>();
/** The providers the wrapped registration saw, so that a repeated install hooks them again. */
const providers = new Set<Provider>();
let track: ((document: vscode.TextDocument, panel: vscode.WebviewPanel, navigation: Navigation) => void) | undefined;
let clock = 0;
const reportOnce = reporter('Markdown Editor selection');

const selectionKey = (s: vscode.Selection | undefined): string => s ? `${s.anchor.line}:${s.anchor.character}-${s.active.line}:${s.active.character}` : 'none';

function isActiveTab(uri: vscode.Uri): boolean {
	const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
	return input instanceof vscode.TabInputCustom && input.viewType === viewType && input.uri.toString() === uri.toString();
}

const newestEditor = (uri: vscode.Uri): Editor | undefined =>
	[...editors.values()].filter(e => e.document.uri.toString() === uri.toString()).sort((a, b) => b.updated - a.updated)[0];

function forget(panel: vscode.WebviewPanel): void {
	editors.get(panel)?.listener.dispose();
	editors.delete(panel);
}

function deliverEditor(editor: Editor): Promise<void> {
	const { selection, document } = editor;
	return deliver(editor, selectionKey(selection), async () =>
		// With no selection the file still goes to Claude Code, as for a text editor's cursor; the start of the file stands in for it.
		({ doc: document, selection: selection ?? new vscode.Selection(0, 0, 0, 0) }),
	() => editor.selection === selection);
}

function trackEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel, navigation: Navigation): void {
	forget(panel);
	const editor: Editor = {
		document, selection: navigation.selection, updated: ++clock,
		listener: navigation.onDidChangeSelection(selection => {
			const changed = selectionKey(selection) !== selectionKey(editor.selection);
			editor.selection = selection;
			editor.updated = ++clock;
			if (changed && isActiveTab(document.uri)) {
				void deliverEditor(editor);
			}
		}),
	};
	editors.set(panel, editor);
	editor.listener = vscode.Disposable.from(editor.listener, panel.onDidDispose(() => forget(panel)));
	if (isActiveTab(document.uri)) {
		void deliverEditor(editor);
	}
}

/** Wraps the provider's method on the instance, which the extension host calls once the editor has resolved. */
function hook(provider: Provider): () => void {
	const original = provider.resolveCustomTextEditorNavigation;
	if (typeof original !== 'function') {
		reportOnce('provider', 'the Markdown Editor provider has no resolveCustomTextEditorNavigation; its selection is not read.');
		return () => undefined;
	}
	const wrapper: NonNullable<Provider['resolveCustomTextEditorNavigation']> = function (this: Provider, document, panel, token) {
		const result = original.call(this, document, panel, token);
		Promise.resolve(result).then(navigation => track?.(document, panel, navigation), () => undefined);
		return result;
	};
	const own = Object.hasOwn(provider, 'resolveCustomTextEditorNavigation');
	provider.resolveCustomTextEditorNavigation = wrapper;
	return () => {
		if (provider.resolveCustomTextEditorNavigation === wrapper) {
			if (own) {
				provider.resolveCustomTextEditorNavigation = original;
			} else {
				delete provider.resolveCustomTextEditorNavigation; // Back to the class's method.
			}
		}
	};
}

// Claude Code may have cleared its chip while another tab was in front, so a Markdown Editor that comes to the front sends its selection again.
let frontUri: string | undefined;

function tabsChanged(): void {
	const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
	const uri = input instanceof vscode.TabInputCustom && input.viewType === viewType ? input.uri : undefined;
	if (uri && uri.toString() !== frontUri) {
		const newest = newestEditor(uri);
		if (newest) {
			void deliverEditor(newest);
		}
	}
	frontUri = uri?.toString();
}

/**
 * Starts reading the Markdown Editor's selection; dispose to stop. Editors that opened before
 * the install are not read.
 */
export function installMarkdownSelection(): vscode.Disposable {
	const api = extensionApi(markdownExtensionId);
	const descriptor = typeof api === 'string' ? undefined : Object.getOwnPropertyDescriptor(api.window, 'registerCustomEditorProvider');
	if (typeof api === 'string' || !descriptor || typeof descriptor.value !== 'function' || !descriptor.writable || !descriptor.configurable) {
		reportOnce('api', `could not wrap registerCustomEditorProvider on the Markdown extension's API object (${typeof api === 'string' ? api : 'not replaceable'}); the Markdown Editor's selection is not read.`);
		return { dispose: () => undefined };
	}
	if (vscode.extensions.getExtension(markdownExtensionId)?.isActive && !providers.size) {
		reportOnce('active', 'the Markdown extension was active before the bridge; reload the window to read the selection of its editors.');
	}
	const restores = new Map<Provider, () => void>();
	const hookOnce = (provider: Provider) => {
		providers.add(provider);
		if (!restores.has(provider)) {
			restores.set(provider, hook(provider));
		}
	};
	providers.forEach(hookOnce);
	const original = descriptor.value as (this: unknown, id: string, provider: Provider, ...rest: unknown[]) => vscode.Disposable;
	const patched: PropertyDescriptor = {
		...descriptor,
		value(this: unknown, id: string, provider: Provider, ...rest: unknown[]) {
			if (id === viewType) {
				try {
					hookOnce(provider);
				} catch (err) {
					reportOnce('hook', `hooking the Markdown Editor provider failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			return original.call(this, id, provider, ...rest);
		},
	};
	Object.defineProperty(api.window, 'registerCustomEditorProvider', patched);
	track = trackEditor;
	const disposables = [
		vscode.window.tabGroups.onDidChangeTabs(tabsChanged),
		vscode.window.tabGroups.onDidChangeTabGroups(tabsChanged),
	];
	return {
		dispose() {
			track = undefined;
			disposables.forEach(d => d.dispose());
			[...editors.keys()].forEach(forget);
			restores.forEach(restore => restore());
			frontUri = undefined;
			// Another extension may have wrapped it since; leave its wrapper in place.
			if (Object.getOwnPropertyDescriptor(api.window, 'registerCustomEditorProvider')?.value === patched.value) {
				Object.defineProperty(api.window, 'registerCustomEditorProvider', descriptor);
			}
		},
	};
}

/** The Markdown Editor in front of each editor group, with its selection. */
export function markdownEditorSelections(): MarkdownEditorState[] {
	const out: MarkdownEditorState[] = [];
	for (const group of vscode.window.tabGroups.all) {
		const input = group.activeTab?.input;
		if (!(input instanceof vscode.TabInputCustom) || input.viewType !== viewType) {
			continue;
		}
		const state: MarkdownEditorState = { uri: input.uri, active: group.isActive, delivered: { chip: false, cli: false } };
		const newest = newestEditor(input.uri);
		if (newest?.selection) {
			const { start, end } = newest.selection;
			state.selection = {
				startLine: start.line + 1,
				// A selection that ends at the start of a line does not include that line.
				endLine: (end.line > start.line && end.character === 0 ? end.line - 1 : end.line) + 1,
				text: newest.document.getText(new vscode.Range(start, end)),
			};
			state.delivered = delivered(newest, selectionKey(newest.selection));
		}
		out.push(state);
	}
	return out;
}
