// The few 'vscode' classes src/render.ts and src/semanticDiffSelection.ts touch, so
// test/render-check.ts and test/semantic-diff-check.ts run in plain Node without a
// VS Code instance.

export class Uri {
	scheme = 'file';
	fsPath = '';
}
export class Position {
	line: number;
	character: number;
	constructor(line = 0, character = 0) {
		this.line = line;
		this.character = character;
	}
	isBefore(other: Position): boolean {
		return this.line < other.line || (this.line === other.line && this.character < other.character);
	}
}
export class Range {
	start: Position;
	end: Position;
	constructor(start = new Position(), end = start) {
		[this.start, this.end] = end.isBefore(start) ? [end, start] : [start, end];
	}
}
export class Selection extends Range {
	anchor: Position;
	active: Position;
	constructor(anchor: Position, active: Position) {
		super(anchor, active);
		this.anchor = anchor;
		this.active = active;
	}
}
export class Location {}
export class MarkdownString {}
export class TextEdit {}
export class WorkspaceEdit {}
export class LanguageModelTextPart {
	value: string;
	constructor(value: string) {
		this.value = value;
	}
}
export class LanguageModelPromptTsxPart {
	value: unknown;
	constructor(value: unknown) {
		this.value = value;
	}
}
export class LanguageModelDataPart {
	data: Uint8Array;
	mimeType: string;
	constructor(data: Uint8Array, mimeType: string) {
		this.data = data;
		this.mimeType = mimeType;
	}
}
export class LanguageModelToolResult {
	content: unknown[];
	constructor(content: unknown[]) {
		this.content = content;
	}
}
