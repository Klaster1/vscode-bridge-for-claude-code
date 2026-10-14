// The MCP tools this window offers. Some are written against the stable VS Code
// API; the rest forward to a language-model tool that Copilot or VS Code core
// registers, found in vscode.lm.tools and called with no chat token.

import * as vscode from 'vscode';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { markdownEditorSelections, markdownSelectionRunning } from './markdownSelection.ts';
import { safeStringify, toolResultToContent } from './render.ts';

type Args = Record<string, unknown>;

export interface BridgeTool {
	definition: Tool;
	call(args: Args, token: vscode.CancellationToken): Promise<CallToolResult>;
}

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text: t }], isError });

function primaryFolder(): vscode.Uri | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri;
}

/** Absolute paths pass through; relative ones are taken from the first workspace folder. */
function toUri(path: string): vscode.Uri {
	if (/^[a-z][a-z0-9+.-]+:\/\//i.test(path)) {
		return vscode.Uri.parse(path);
	}
	if (/^([a-z]:[\\/]|[\\/])/i.test(path)) {
		return vscode.Uri.file(path);
	}
	const root = primaryFolder();
	if (!root) {
		throw new Error(`Relative path "${path}" needs an open workspace folder`);
	}
	return vscode.Uri.joinPath(root, path.replace(/\\/g, '/'));
}

const str = (v: unknown, name: string): string => {
	if (typeof v !== 'string' || !v) {
		throw new Error(`"${name}" must be a non-empty string`);
	}
	return v;
};

// --- get_diagnostics -------------------------------------------------------

const severityNames = ['error', 'warning', 'info', 'hint'] as const;

/**
 * Makes sure a file is open in an editor tab and, if it was not, waits for its
 * language server to report on it. In testing, TypeScript reported nothing for
 * a document opened without a tab, so an unopened file is shown as a background
 * preview tab (focus stays where it was). A server often reports an empty list first
 * (syntax) and the type errors later, so an empty report does not end the
 * wait: it ends 1.5 s after the last non-empty report, or after waitMs in
 * total. A clean file therefore costs the full waitMs.
 */
async function openAndSettle(uri: vscode.Uri, waitMs: number): Promise<void> {
	const inTab = vscode.window.tabGroups.all.some(g => g.tabs.some(t => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString()));
	if (inTab) {
		return;
	}
	const settled = waitForDiagnostics(uri, waitMs);
	await vscode.window.showTextDocument(uri, { preview: true, preserveFocus: true });
	await settled;
}

function waitForDiagnostics(uri: vscode.Uri, waitMs: number): Promise<void> {
	return new Promise<void>(done => {
		const total = setTimeout(finish, waitMs);
		let quiet: ReturnType<typeof setTimeout> | undefined;
		const sub = vscode.languages.onDidChangeDiagnostics(e => {
			if (e.uris.some(u => u.toString() === uri.toString())) {
				clearTimeout(quiet);
				if (vscode.languages.getDiagnostics(uri).length > 0) {
					quiet = setTimeout(finish, 1500);
				}
			}
		});
		function finish() {
			clearTimeout(total);
			clearTimeout(quiet);
			sub.dispose();
			done();
		}
	});
}

const getDiagnostics: BridgeTool = {
	definition: {
		name: 'get_diagnostics',
		description: 'Problems-panel diagnostics (type errors, lint findings) from VS Code\'s language servers. With `paths`, checks those files one by one, first opening each in a background preview tab if it is not in a tab already (TypeScript does not check files that are not in a tab). Without, returns what the Problems panel holds now, which covers only files the language servers have seen.',
		inputSchema: {
			type: 'object',
			properties: {
				paths: { type: 'array', items: { type: 'string' }, description: 'Files to check, absolute or relative to the first workspace folder.' },
				minSeverity: { type: 'string', enum: [...severityNames], description: 'Lowest severity to include. Default: warning.' },
				sources: { type: 'array', items: { type: 'string' }, description: 'Only include these diagnostic sources, e.g. ["ts", "eslint"].' },
				waitMs: { type: 'number', description: 'How long to wait for a newly opened file\'s first diagnostics. Default 3000.' },
			},
		},
	},
	async call(args) {
		const minIndex = severityNames.indexOf((args['minSeverity'] as typeof severityNames[number]) ?? 'warning');
		const sources = Array.isArray(args['sources']) ? (args['sources'] as string[]).map(s => s.toLowerCase()) : undefined;
		const paths = Array.isArray(args['paths']) ? (args['paths'] as string[]) : undefined;
		let entries: [vscode.Uri, readonly vscode.Diagnostic[]][];
		if (paths?.length) {
			const uris = paths.map(toUri);
			const waitMs = typeof args['waitMs'] === 'number' ? args['waitMs'] : 3000;
			entries = [];
			// One at a time: each file is read before the next one takes over the preview tab.
			for (const u of uris) {
				await openAndSettle(u, waitMs);
				entries.push([u, vscode.languages.getDiagnostics(u)]);
			}
		} else {
			entries = vscode.languages.getDiagnostics();
		}
		const lines: string[] = [];
		for (const [uri, diags] of entries) {
			for (const d of diags) {
				if (d.severity > (minIndex < 0 ? 1 : minIndex)) {
					continue;
				}
				if (sources && !sources.includes((d.source ?? '').toLowerCase())) {
					continue;
				}
				const code = typeof d.code === 'object' ? d.code.value : d.code;
				const where = `${uri.scheme === 'file' ? uri.fsPath : uri.toString()}:${d.range.start.line + 1}:${d.range.start.character + 1}`;
				lines.push(`${where} ${severityNames[d.severity]} [${d.source ?? '?'}${code !== undefined ? ` ${code}` : ''}] ${d.message}`);
			}
		}
		return text(lines.length ? lines.join('\n') : 'No diagnostics.');
	},
};

// --- rename_symbol ---------------------------------------------------------

const renameSymbol: BridgeTool = {
	definition: {
		name: 'rename_symbol',
		description: 'Rename a symbol across the workspace with the language server\'s rename (updates imports and references), then save the changed files. Locate the symbol by line plus either character or the symbol\'s text on that line.',
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'File containing the symbol.' },
				line: { type: 'number', description: 'Line of the symbol, 1-based.' },
				character: { type: 'number', description: 'Column of the symbol, 1-based. Omit to use `symbol`.' },
				symbol: { type: 'string', description: 'Current name; its first whole-word match on `line` is used when `character` is omitted.' },
				newName: { type: 'string' },
				save: { type: 'boolean', description: 'Save every changed file afterwards. Default true, so the edit is visible on disk.' },
			},
			required: ['path', 'line', 'newName'],
		},
	},
	async call(args) {
		const uri = toUri(str(args['path'], 'path'));
		const newName = str(args['newName'], 'newName');
		const doc = await vscode.workspace.openTextDocument(uri);
		const line = Number(args['line']) - 1;
		if (!(line >= 0 && line < doc.lineCount)) {
			return text(`Line ${args['line']} is outside ${uri.fsPath} (${doc.lineCount} lines)`, true);
		}
		let character: number;
		if (typeof args['character'] === 'number') {
			character = args['character'] - 1;
		} else {
			const symbol = str(args['symbol'], 'symbol');
			const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const match = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).exec(doc.lineAt(line).text);
			if (!match) {
				return text(`"${symbol}" is not on line ${line + 1} of ${uri.fsPath}`, true);
			}
			character = match.index;
		}
		const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit | undefined>(
			'vscode.executeDocumentRenameProvider', uri, new vscode.Position(line, character), newName);
		if (!edit || edit.size === 0) {
			return text('The rename provider returned no edits.', true);
		}
		if (!await vscode.workspace.applyEdit(edit)) {
			return text('VS Code refused to apply the rename edit.', true);
		}
		const changed: string[] = [];
		for (const [fileUri, edits] of edit.entries()) {
			if (args['save'] !== false) {
				const changedDoc = await vscode.workspace.openTextDocument(fileUri);
				await changedDoc.save();
			}
			changed.push(`${fileUri.fsPath} (${edits.length} edit${edits.length === 1 ? '' : 's'})`);
		}
		return text(`Renamed to "${newName}" in ${changed.length} file(s):\n${changed.join('\n')}`);
	},
};

// --- execute_command / list_commands -------------------------------------

/** `*` matches any run of characters; everything else is literal. */
function matchesAny(id: string, patterns: readonly string[]): boolean {
	return patterns.some(p => new RegExp(`^${p.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(id));
}

function commandAllowed(id: string): boolean {
	const config = vscode.workspace.getConfiguration('vscodeToolsBridge.executeCommand');
	return matchesAny(id, config.get<string[]>('allow', ['*'])) && !matchesAny(id, config.get<string[]>('deny', []));
}

/** Turns {"$uri"}, {"$position"} and {"$range"} markers in arguments into VS Code objects. */
function reviveArg(v: unknown): unknown {
	if (Array.isArray(v)) {
		return v.map(reviveArg);
	}
	if (v && typeof v === 'object') {
		const o = v as Record<string, unknown>;
		if (typeof o['$uri'] === 'string') {
			return toUri(o['$uri']);
		}
		const pos = (p: unknown) => {
			const { line, character } = p as { line: number; character: number };
			return new vscode.Position(line, character);
		};
		if (o['$position']) {
			return pos(o['$position']);
		}
		if (o['$range']) {
			const { start, end } = o['$range'] as { start: unknown; end: unknown };
			return new vscode.Range(pos(start), pos(end));
		}
		return Object.fromEntries(Object.entries(o).map(([k, val]) => [k, reviveArg(val)]));
	}
	return v;
}

const executeCommand: BridgeTool = {
	definition: {
		name: 'execute_command',
		description: 'Run any VS Code command (vscode.commands.executeCommand) and return its result as JSON. No confirmation is shown; the vscodeToolsBridge.executeCommand.allow/deny settings limit which commands run. Arguments are JSON; write {"$uri": "path"} for a Uri, {"$position": {"line": 0, "character": 0}} for a Position and {"$range": {"start": {...}, "end": {...}}} for a Range (all 0-based, as in the VS Code API). Example: {"command": "vscode.executeDefinitionProvider", "args": [{"$uri": "src/a.ts"}, {"$position": {"line": 9, "character": 4}}]}.',
		inputSchema: {
			type: 'object',
			properties: {
				command: { type: 'string', description: 'Command ID.' },
				args: { type: 'array', items: {}, description: 'Positional arguments.' },
			},
			required: ['command'],
		},
	},
	async call(args) {
		const id = str(args['command'], 'command');
		if (!commandAllowed(id)) {
			return text(`Command "${id}" is blocked by the vscodeToolsBridge.executeCommand allow/deny settings.`, true);
		}
		const commandArgs = Array.isArray(args['args']) ? args['args'].map(reviveArg) : [];
		const result = await vscode.commands.executeCommand(id, ...commandArgs);
		return text(result === undefined ? '(command returned nothing)' : safeStringify(result));
	},
};

const listCommands: BridgeTool = {
	definition: {
		name: 'list_commands',
		description: 'List VS Code command IDs that execute_command may run, filtered by a case-insensitive substring.',
		inputSchema: {
			type: 'object',
			properties: { filter: { type: 'string', description: 'Substring to match, e.g. "git." or "format".' } },
			required: ['filter'],
		},
	},
	async call(args) {
		const filter = str(args['filter'], 'filter').toLowerCase();
		const ids = (await vscode.commands.getCommands(true)).filter(id => id.toLowerCase().includes(filter) && commandAllowed(id)).sort();
		return text(ids.length ? ids.slice(0, 500).join('\n') + (ids.length > 500 ? `\n[${ids.length - 500} more]` : '') : 'No matching commands.');
	},
};

// --- open_files / list_workspaces -----------------------------------------

const openFiles: BridgeTool = {
	definition: {
		name: 'open_files',
		description: 'Open files in the VS Code editor for the user to see. Append :line to a path to reveal that line.',
		inputSchema: {
			type: 'object',
			properties: {
				paths: { type: 'array', items: { type: 'string' }, description: 'Absolute or workspace-relative paths, optionally ending in :line.' },
				background: { type: 'boolean', description: 'Keep focus where it is. Default false.' },
			},
			required: ['paths'],
		},
	},
	async call(args) {
		const opened: string[] = [];
		for (const raw of (args['paths'] as string[] | undefined) ?? []) {
			const m = /^(.*?):(\d+)$/.exec(raw);
			const uri = toUri(m?.[1] ?? raw);
			const line = m?.[2] ? Number(m[2]) - 1 : undefined;
			const selection = line !== undefined ? new vscode.Range(line, 0, line, 0) : undefined;
			await vscode.window.showTextDocument(uri, { preview: false, preserveFocus: args['background'] === true, selection });
			opened.push(uri.fsPath);
		}
		return text(`Opened:\n${opened.join('\n')}`);
	},
};

export function listWorkspacesTool(info: () => object): BridgeTool {
	return {
		definition: {
			name: 'list_workspaces',
			description: 'This VS Code window\'s workspace: name, workspace file and folders. The first folder is the one this bridge is registered under.',
			inputSchema: { type: 'object', properties: {} },
		},
		async call() {
			return text(safeStringify({
				name: vscode.workspace.name,
				workspaceFile: vscode.workspace.workspaceFile?.fsPath ?? null,
				folders: (vscode.workspace.workspaceFolders ?? []).map(f => ({ name: f.name, path: f.uri.fsPath })),
				bridge: info(),
			}));
		},
	};
}

// --- tools forwarded to vscode.lm.tools -----------------------------------

/** Language-model tools to republish, keyed by their VS Code name, with the MCP name to use. */
const forwarded: Record<string, string> = {
	copilot_searchCodebase: 'semantic_search',
	copilot_getVSCodeAPI: 'vscode_api_reference',
	terminal_selection: 'terminal_selection',
	terminal_last_command: 'terminal_last_command',
	open_browser_page: 'open_browser_page',
	read_page: 'read_page',
	screenshot_page: 'screenshot_page',
	navigate_page: 'navigate_page',
	click_element: 'click_element',
	drag_element: 'drag_element',
	hover_element: 'hover_element',
	type_in_page: 'type_in_page',
	run_playwright_code: 'run_playwright_code',
	handle_dialog: 'handle_dialog',
	list_browser_pages: 'list_browser_pages',
};

/**
 * Forwarded tools that ask for confirmation. Called without a chat session,
 * VS Code turns that into a modal dialog in the window, and the call waits
 * until someone answers it.
 */
const confirming = new Set(['open_browser_page', 'navigate_page', 'run_playwright_code']);

/**
 * With vscodeToolsBridge.autoApprove on, answers those confirmations the way a
 * chat preToolUse hook would, so VS Code runs the tool without the dialog.
 * Copilot never shows one because the chat path honours
 * chat.tools.global.autoApprove; the tokenless path ignores that setting and
 * only skips the dialog for a hook's "allow". VS Code forwards the
 * preToolUseResult field only from an extension granted the
 * chatParticipantPrivate proposal (via argv.json enable-proposed-api), and
 * silently drops it otherwise, so the dialog then still shows.
 */
function approval(): object {
	return vscode.workspace.getConfiguration('vscodeToolsBridge').get<boolean>('autoApprove', true)
		? { preToolUseResult: { permissionDecision: 'allow' } }
		: {};
}

/**
 * The forwarded tools that exist in this window right now. Copilot's appear
 * only while Copilot is active; the browser ones only while
 * workbench.browser.enableChatTools is on. Schemas and descriptions are VS
 * Code's own, so they can mention sibling tools by their VS Code names.
 */
function forwardedTools(): BridgeTool[] {
	const out: BridgeTool[] = [];
	for (const info of vscode.lm.tools) {
		const mcpName = forwarded[info.name];
		if (!mcpName) {
			continue;
		}
		const note = confirming.has(info.name) && !('preToolUseResult' in approval()) ? ' VS Code first shows the user a confirmation dialog, and the call waits for the answer.' : '';
		out.push({
			definition: {
				name: mcpName,
				description: `${info.description}\n\n(VS Code tool "${info.name}", called without a chat session.${note})`,
				inputSchema: { type: 'object', ...(info.inputSchema as object | undefined) } as Tool['inputSchema'],
			},
			async call(args, token) {
				const result = await vscode.lm.invokeTool(info.name, { input: args, toolInvocationToken: undefined, ...approval() }, token);
				return { content: await toolResultToContent(result) };
			},
		});
	}
	return out;
}

// --- shared_browser_pages ----------------------------------------------------

interface SharedPage {
	id: string;
	title: string;
	url: string;
	/** "active", "visible" or "not visible", as VS Code reports it. */
	visibility: string;
}

/**
 * Pages shared with the agent: the ones the user shared with the page
 * toolbar's "Share with Agent" button, plus the ones open_browser_page opened.
 * VS Code has no API for the sharing state, so this reads the "shared with
 * you" section of list_browser_pages, whose lines VS Code formats as
 * `- [pageId] Title (url) (active|visible|not visible)`. A page whose address
 * the network policy blocks comes back with its title masked and no URL.
 */
async function sharedPages(token: vscode.CancellationToken): Promise<SharedPage[] | undefined> {
	if (!vscode.lm.tools.some(t => t.name === 'list_browser_pages')) {
		return undefined;
	}
	const result = await vscode.lm.invokeTool('list_browser_pages', { input: {}, toolInvocationToken: undefined }, token);
	const listing = result.content.map(p => p instanceof vscode.LanguageModelTextPart ? p.value : '').join('\n');
	const section = /currently shared with you[^\n]*\n((?:- .*(?:\n|$))*)/.exec(listing)?.[1] ?? '';
	const pages: SharedPage[] = [];
	for (const line of section.split('\n')) {
		const m = /^- \[([^\]]+)\] (.*?) \((active|visible|not visible)\)$/.exec(line);
		if (!m) {
			continue;
		}
		const rest = m[2]!.replace(/ \(resource-backed[^)]*\)$/, '');
		const u = / \((\S+)\)$/.exec(rest);
		pages.push({ id: m[1]!, title: u ? rest.slice(0, u.index) : rest, url: u?.[1] ?? '', visibility: m[3]! });
	}
	return pages;
}

const sharedBrowserPages: BridgeTool = {
	definition: {
		name: 'shared_browser_pages',
		description: 'Integrated-browser pages shared with you: those the user shared with the page toolbar\'s "Share with Agent" button, and those you opened with open_browser_page. Returns each page\'s ID, title and URL and, unless `snapshot` is false, its accessibility snapshot (from read_page). Use the page ID with read_page, screenshot_page, click_element and the other browser tools.',
		inputSchema: {
			type: 'object',
			properties: {
				snapshot: { type: 'boolean', description: 'Include each page\'s text snapshot. Default true.' },
				maxChars: { type: 'number', description: 'Cap on each snapshot. Default 4000.' },
			},
		},
	},
	async call(args, token) {
		const pages = await sharedPages(token);
		if (!pages) {
			return text('The integrated browser\'s agent tools are not available in this window (workbench.browser.enableChatTools is off, or chat is disabled).', true);
		}
		if (pages.length === 0) {
			return text('No browser pages are shared with you.');
		}
		const maxChars = typeof args['maxChars'] === 'number' ? args['maxChars'] : 4000;
		const blocks: string[] = [];
		for (const p of pages) {
			let block = `## ${p.title}\nURL: ${p.url || '(hidden by network policy)'}\nPage ID: ${p.id} (${p.visibility})`;
			if (args['snapshot'] !== false) {
				const read = await vscode.lm.invokeTool('read_page', { input: { pageId: p.id }, toolInvocationToken: undefined }, token);
				const snap = (await toolResultToContent(read)).map(c => c.type === 'text' ? c.text : '').join('\n');
				block += `\n\n${snap.length > maxChars ? `${snap.slice(0, maxChars)}\n[snapshot truncated at ${maxChars} characters]` : snap}`;
			}
			blocks.push(block);
		}
		return text(blocks.join('\n\n'));
	},
};

// --- visible_images ----------------------------------------------------------

/** The image types Claude Code's Read tool shows as images. */
const imageFile = /\.(png|jpe?g|gif|webp)$/i;

/**
 * Image files shown in an editor group right now. An image opens in VS Code's
 * image preview, a custom editor, so Claude Code's own IDE context, which
 * follows the active text editor, never reports it.
 */
function visibleImages(): { path: string; active: boolean }[] {
	const out: { path: string; active: boolean }[] = [];
	for (const group of vscode.window.tabGroups.all) {
		const input = group.activeTab?.input;
		const uri = input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText ? input.uri : undefined;
		if (uri?.scheme === 'file' && imageFile.test(uri.path)) {
			out.push({ path: uri.fsPath, active: group.isActive });
		}
	}
	return out;
}

const visibleImagesTool: BridgeTool = {
	definition: {
		name: 'visible_images',
		description: 'Image files (PNG, JPEG, GIF, WebP) the user has on screen: the front tab of each editor group. Returns their paths; read a path with the Read tool to see the image.',
		inputSchema: { type: 'object', properties: {} },
	},
	async call() {
		const images = visibleImages();
		return text(images.length ? images.map(i => `- ${i.path}${i.active ? ' (active)' : ''}`).join('\n') : 'No image files are on screen.');
	},
};

// --- markdown_editor_selection ---------------------------------------------

/** A code fence longer than any backtick run in the text. */
const fenceFor = (t: string): string => '`'.repeat(Math.max(3, ...[...t.matchAll(/`+/g)].map(m => m[0].length + 1)));

const markdownEditorSelectionTool: BridgeTool = {
	definition: {
		name: 'markdown_editor_selection',
		description: 'The text the user has selected in VS Code\'s rich Markdown Editor: the front tab of each editor group that shows one. Returns the file path, the 1-based line range and the selected text; with nothing selected, the cursor line. Claude Code\'s own IDE context does not report this editor.',
		inputSchema: {
			type: 'object',
			properties: {
				selectedOnly: { type: 'boolean', description: 'Report only editors with selected text. Default false.' },
				skipDelivered: { type: 'boolean', description: 'Leave out editors whose selection Claude Code\'s selection chip already shows. Default false.' },
				maxChars: { type: 'number', description: 'Cap on each selected text. Default 4000.' },
			},
		},
	},
	async call(args) {
		if (!markdownSelectionRunning()) {
			return text('The Markdown Editor selection is not being read: vscodeToolsBridge.markdownEditor.selection is off, or the output channel says why it could not start. After turning it on, reopen the editor.');
		}
		const maxChars = typeof args['maxChars'] === 'number' ? args['maxChars'] : 4000;
		const entries: string[] = [];
		for (const { uri, active, selection, delivered } of await markdownEditorSelections()) {
			if (delivered && args['skipDelivered'] === true) {
				continue;
			}
			const name = `${uri.scheme === 'file' ? uri.fsPath : uri.toString()}${active ? ' (active)' : ''}`;
			if (!selection) {
				if (args['selectedOnly'] !== true) {
					entries.push(`- ${name}: no selection reported. Reopen the editor if the bridge started after it opened.`);
				}
			} else if (!selection.text) {
				if (args['selectedOnly'] !== true) {
					entries.push(`- ${name}: nothing selected, cursor on line ${selection.startLine}.`);
				}
			} else {
				const lines = selection.startLine === selection.endLine ? `line ${selection.startLine}` : `lines ${selection.startLine}-${selection.endLine}`;
				const shown = selection.text.length > maxChars ? `${selection.text.slice(0, maxChars)}\n[selection truncated at ${maxChars} of ${selection.text.length} characters]` : selection.text;
				const fence = fenceFor(shown);
				entries.push(`- ${name}, ${lines}${delivered ? ', shown in Claude Code\'s selection chip' : ''}, selected text:\n${fence}\n${shown}\n${fence}`);
			}
		}
		return text(entries.length ? entries.join('\n') : args['skipDelivered'] === true ? 'No Markdown Editor has selected text beyond what Claude Code\'s selection chip shows.' : args['selectedOnly'] === true ? 'No Markdown Editor has selected text.' : 'No Markdown Editor is in front in an editor group.');
	},
};

export function allTools(info: () => object): BridgeTool[] {
	const forwardedNow = forwardedTools();
	const browser = forwardedNow.some(t => t.definition.name === 'list_browser_pages') ? [sharedBrowserPages] : [];
	return [getDiagnostics, renameSymbol, executeCommand, listCommands, openFiles, listWorkspacesTool(info), visibleImagesTool, markdownEditorSelectionTool, ...forwardedNow, ...browser];
}
