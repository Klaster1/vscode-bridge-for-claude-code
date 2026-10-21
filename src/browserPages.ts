// The integrated browser's pages shared with the agent, and the text selected on one, read
// through VS Code's own browser tools, for tools.ts and browserSelection.ts.

import * as vscode from 'vscode';

/** Whether a tool that asks for confirmation runs without the dialog; see `approval`. */
export const autoApprove = (): boolean => vscode.workspace.getConfiguration('vscodeBridge').get<boolean>('autoApprove', true);

/**
 * With vscodeBridge.autoApprove on, answers those confirmations the way a
 * chat preToolUse hook would, so VS Code runs the tool without the dialog.
 * Copilot never shows one because the chat path honours
 * chat.tools.global.autoApprove; the tokenless path ignores that setting and
 * only skips the dialog for a hook's "allow". VS Code forwards the
 * preToolUseResult field only from an extension granted the
 * chatParticipantPrivate proposal (via argv.json enable-proposed-api), and
 * silently drops it otherwise, so the dialog then still shows.
 */
export function approval(): object {
	return autoApprove() ? { preToolUseResult: { permissionDecision: 'allow' } } : {};
}

export interface SharedPage {
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
export async function sharedPages(token: vscode.CancellationToken): Promise<SharedPage[] | undefined> {
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

/** Cuts a Select All on a long page. */
const maxSelection = 100_000;

/**
 * The text selected in a page's top document, or undefined when the page does not answer. The
 * call runs Playwright code, so VS Code asks for confirmation unless `approval` skips it.
 */
export async function pageSelection(pageId: string, token: vscode.CancellationToken): Promise<string | undefined> {
	const code = `return page.evaluate(() => window.getSelection()?.toString().slice(0, ${maxSelection}) ?? '')`;
	const result = await vscode.lm.invokeTool('run_playwright_code', { input: { pageId, code }, toolInvocationToken: undefined, ...approval() }, token);
	const reply = result.content.flatMap(p => p instanceof vscode.LanguageModelTextPart ? [p.value] : []).find(v => v.startsWith('Result: '));
	try {
		const value: unknown = reply && JSON.parse(reply.slice('Result: '.length));
		return typeof value === 'string' ? value : undefined;
	} catch {
		return undefined;
	}
}
