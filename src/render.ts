// Turns what VS Code hands back (language-model tool results, command return
// values) into MCP content that Claude Code can read.

import * as vscode from 'vscode';
import promptTsx from '@vscode/prompt-tsx';
import type { BasePromptElementProps, ITokenizer, PromptPiece, Raw } from '@vscode/prompt-tsx';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

type Content = CallToolResult['content'][number];

const { PromptElement, UserMessage, ToolResult, renderPrompt, OutputMode } = promptTsx;

interface ToolResultProps extends BasePromptElementProps {
	data: vscode.LanguageModelToolResult;
}

/** Wraps a tool result in a user message, which is all the renderer needs. */
class ToolResultPrompt extends PromptElement<ToolResultProps> {
	render(): PromptPiece {
		// vscpp is the JSX factory prompt-tsx installs globally; called directly here
		// because type stripping cannot compile JSX. Its declared return type is
		// internal, hence the cast.
		return vscpp(UserMessage, {}, vscpp(ToolResult, { data: this.props.data })) as unknown as PromptPiece;
	}
}

const partTokens = (part: Raw.ChatCompletionContentPart): number => 'text' in part ? Math.ceil(part.text.length / 4) : 1;

/**
 * Copilot's tools return prompt-tsx trees (LanguageModelPromptTsxPart) that are
 * meant to be laid out into a model prompt. This renders one to plain text
 * with a budget large enough that nothing is pruned. Token counts are rough
 * (4 characters per token) because they only feed the pruning that the
 * budget already turns off.
 */
const roughTokenizer: ITokenizer<typeof OutputMode.Raw> = {
	mode: OutputMode.Raw,
	tokenLength: partTokens,
	countMessageTokens(message: Raw.ChatMessage) {
		let n = 4;
		for (const part of message.content) {
			n += partTokens(part);
		}
		return n;
	},
};

async function renderPromptTsx(part: vscode.LanguageModelPromptTsxPart): Promise<string> {
	const result = new vscode.LanguageModelToolResult([part]);
	const { messages } = await renderPrompt(ToolResultPrompt, { data: result }, { modelMaxPromptTokens: 2_000_000 }, roughTokenizer);
	const texts: string[] = [];
	for (const message of messages) {
		for (const piece of message.content) {
			if ('text' in piece && typeof piece.text === 'string') {
				texts.push(piece.text);
			}
		}
	}
	return texts.join('\n');
}

/** Maps each part of a language-model tool result to MCP content. */
export async function toolResultToContent(result: vscode.LanguageModelToolResult): Promise<Content[]> {
	const out: Content[] = [];
	for (const part of result.content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			out.push({ type: 'text', text: part.value });
		} else if (part instanceof vscode.LanguageModelPromptTsxPart) {
			out.push({ type: 'text', text: await renderPromptTsx(part) });
		} else if (part instanceof vscode.LanguageModelDataPart) {
			const mime = part.mimeType;
			if (mime.startsWith('image/')) {
				out.push({ type: 'image', mimeType: mime, data: Buffer.from(part.data).toString('base64') });
			} else if (mime.startsWith('text/') || mime.includes('json')) {
				out.push({ type: 'text', text: new TextDecoder().decode(part.data) });
			} else {
				out.push({ type: 'text', text: `[${part.data.byteLength} bytes of ${mime} omitted]` });
			}
		} else {
			out.push({ type: 'text', text: safeStringify(part) });
		}
	}
	return out.length ? out : [{ type: 'text', text: '(empty result)' }];
}

const MAX_OUTPUT = 100_000;
const MAX_DEPTH = 8;
const MAX_ITEMS = 1_000;

/**
 * JSON for any command return value. VS Code objects (Uri, Position, Range,
 * Location, MarkdownString, TextEdit, WorkspaceEdit) become plain shapes, cycles
 * and functions become markers, and the output is capped at 100k characters,
 * since a command can return a whole document model.
 */
export function safeStringify(value: unknown): string {
	const seen = new WeakSet<object>();
	const walk = (v: unknown, depth: number): unknown => {
		if (v === undefined) {
			return null;
		}
		if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
			return v;
		}
		if (typeof v === 'bigint') {
			return v.toString();
		}
		if (typeof v === 'function') {
			return '[Function]';
		}
		if (typeof v !== 'object') {
			return String(v);
		}
		if (v instanceof vscode.Uri) {
			return v.scheme === 'file' ? v.fsPath : v.toString();
		}
		if (v instanceof vscode.Position) {
			return { line: v.line, character: v.character };
		}
		if (v instanceof vscode.Range) {
			return { start: walk(v.start, depth), end: walk(v.end, depth) };
		}
		if (v instanceof vscode.Location) {
			return { uri: walk(v.uri, depth), range: walk(v.range, depth) };
		}
		// These keep their data in private fields or getters, so the generic walk below would return {}.
		if (v instanceof vscode.MarkdownString) {
			return { value: v.value };
		}
		if (v instanceof vscode.TextEdit) {
			return { range: walk(v.range, depth), newText: v.newText };
		}
		if (v instanceof vscode.WorkspaceEdit) {
			return v.entries().map(([uri, edits]) => ({ uri: walk(uri, depth), edits: walk(edits, depth) })); // Text edits only: the API shows no file operations.
		}
		if (v instanceof Uint8Array) {
			return `[${v.byteLength} bytes]`;
		}
		if (seen.has(v)) {
			return '[Circular]';
		}
		if (depth >= MAX_DEPTH) {
			return '[Truncated]';
		}
		seen.add(v);
		if (v instanceof Map) {
			return walk(Object.fromEntries(v), depth + 1);
		}
		if (v instanceof Set || Array.isArray(v)) {
			const items = [...v];
			const mapped = items.slice(0, MAX_ITEMS).map(item => walk(item, depth + 1));
			if (items.length > MAX_ITEMS) {
				mapped.push(`[${items.length - MAX_ITEMS} more]`);
			}
			return mapped;
		}
		const obj: Record<string, unknown> = {};
		for (const key of Object.keys(v)) {
			if (key.startsWith('_')) {
				continue;
			}
			obj[key] = walk((v as Record<string, unknown>)[key], depth + 1);
		}
		return obj;
	};
	const text = JSON.stringify(walk(value, 0), null, 2) ?? 'null';
	return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n[output truncated at ${MAX_OUTPUT} characters]` : text;
}
