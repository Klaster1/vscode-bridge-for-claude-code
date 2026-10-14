// The few 'vscode' classes src/render.ts touches, so test/render-check.ts can
// run the renderer in plain Node without a VS Code instance.

export class Uri {
	scheme = 'file';
	fsPath = '';
}
export class Position {
	line = 0;
	character = 0;
}
export class Range {}
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
