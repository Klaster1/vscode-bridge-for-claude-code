// Colors code the way VS Code's editor does: it runs the TextMate grammars of the installed
// extensions with vscode-textmate, and takes the colors from the active color theme and the
// user's editor.tokenColorCustomizations. The extension API has no call for this, so the grammars
// and the theme are read from the extensions' own files. The module takes what it reads from VS Code
// as `Sources`, so that an offline check can run it with a fixture.

import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { IGrammar, IRawTheme, Registry } from 'vscode-textmate';

/** A colored stretch of the text: start and end offsets, the color, and VS Code's font style bits (1 italic, 2 bold, 4 underline, 8 strikethrough). */
export type Token = [start: number, end: number, color: string, fontStyle: number];

/** What an extension's package.json contributes that the tokenizer reads. */
export interface Contributes {
	languages?: { id: string; aliases?: string[]; extensions?: string[] }[];
	grammars?: { language?: string; scopeName: string; path: string }[];
	themes?: { id?: string; label: string; path: string }[];
}

export interface Sources {
	/** The installed extensions: where each one lives and what it contributes. */
	extensions(): { path: string; contributes: Contributes }[];
	/** The `workbench.colorTheme` setting. */
	theme(): string | undefined;
	/** The `editor.tokenColorCustomizations` setting. */
	customizations(): unknown;
}

const maxLength = 50_000;

/** A CommonJS package imported from an ES module: its exports sit on `default` when Node cannot name them. */
const exportsOf = <T>(module: T & { default?: T }): T => module.default ?? module;
const textmateModule = async () => exportsOf(await import('vscode-textmate'));

interface ThemeFile {
	include?: string;
	colors?: Record<string, string>;
	tokenColors?: string | IRawTheme['settings'];
}

/** The text of a JSON file that may hold comments and trailing commas, as VS Code's theme files do. */
function parseJsonc(text: string): unknown {
	let out = '';
	for (let i = 0; i < text.length; i++) {
		const c = text[i]!;
		if (c === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') {
				j += text[j] === '\\' ? 2 : 1;
			}
			out += text.slice(i, j + 1);
			i = j;
		} else if (c === '/' && text[i + 1] === '/') {
			while (i < text.length && text[i] !== '\n') {
				i++;
			}
			out += '\n';
		} else if (c === '/' && text[i + 1] === '*') {
			i = text.indexOf('*/', i + 2) + 1;
			if (i === 0) {
				break;
			}
		} else {
			out += c;
		}
	}
	return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

async function readTheme(file: string, colors: Record<string, string>): Promise<IRawTheme['settings']> {
	const theme = parseJsonc(await readFile(file, 'utf8')) as ThemeFile;
	const settings = theme.include ? await readTheme(join(dirname(file), theme.include), colors) : [];
	Object.assign(colors, theme.colors);
	if (typeof theme.tokenColors === 'string') {
		if (/\.tmTheme$/i.test(theme.tokenColors)) {
			return settings; // Property lists are not read.
		}
		const included = parseJsonc(await readFile(join(dirname(file), theme.tokenColors), 'utf8')) as { tokenColors?: IRawTheme['settings'] } | IRawTheme['settings'];
		return [...settings, ...(Array.isArray(included) ? included : included.tokenColors ?? [])];
	}
	return [...settings, ...theme.tokenColors ?? []];
}

type Rules = { textMateRules?: { scope?: string | string[]; settings: Record<string, string> }[] };

async function loadTheme(sources: Sources): Promise<IRawTheme> {
	const wanted = sources.theme();
	const entry = sources.extensions().flatMap(({ path, contributes }) => (contributes.themes ?? []).map(theme => ({ path, theme })))
		// VS Code once named its built-in themes "Default Dark Modern"; a settings file can still hold that.
		.find(({ theme }) => [theme.id, theme.label].some(name => name !== undefined && (name === wanted || name === wanted?.replace(/^Default /, ''))));
	const colors: Record<string, string> = {};
	const rules = entry ? await readTheme(join(entry.path, entry.theme.path), colors) : [];
	const custom = (sources.customizations() ?? {}) as Rules & Record<string, unknown>;
	const forTheme = (wanted ? (custom[wanted] as Rules | undefined)?.textMateRules : undefined) ?? [];
	return {
		name: wanted,
		settings: [
			{ settings: { foreground: colors['editor.foreground'], background: colors['editor.background'] } }, // The default token color.
			...rules,
			...(custom.textMateRules ?? []),
			...forTheme,
		],
	};
}

type Loaded = { registry: Registry; scopeOf: (tag: string) => string | undefined; grammars: Map<string, Promise<IGrammar | null>> };

async function load(sources: Sources): Promise<Loaded> {
	const require = createRequire(import.meta.url);
	const textmate = await textmateModule();
	const oniguruma = exportsOf(await import('vscode-oniguruma'));
	const wasm = await readFile(require.resolve('vscode-oniguruma/release/onig.wasm'));
	await oniguruma.loadWASM({ data: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer });

	const languages = new Map<string, string>(); // A fence tag: a language ID or an alias.
	const byExtension = new Map<string, string>(); // A fence tag: a file extension.
	const scopes = new Map<string, { scopeName: string; file: string }>(); // A language ID or a scope name.
	for (const { path, contributes } of sources.extensions()) {
		for (const language of contributes.languages ?? []) {
			languages.set(language.id.toLowerCase(), language.id);
			for (const alias of language.aliases ?? []) {
				if (!languages.has(alias.toLowerCase())) {
					languages.set(alias.toLowerCase(), language.id);
				}
			}
			for (const ext of language.extensions ?? []) {
				const key = ext.replace(/^\./, '').toLowerCase();
				if (!byExtension.has(key)) {
					byExtension.set(key, language.id);
				}
			}
		}
		for (const grammar of contributes.grammars ?? []) {
			const found = { scopeName: grammar.scopeName, file: join(path, grammar.path) };
			scopes.set(grammar.scopeName, found);
			if (grammar.language && !scopes.has(grammar.language)) {
				scopes.set(grammar.language, found);
			}
		}
	}
	const registry = new textmate.Registry({
		onigLib: Promise.resolve({ createOnigScanner: patterns => new oniguruma.OnigScanner(patterns), createOnigString: text => new oniguruma.OnigString(text) }),
		loadGrammar: async scopeName => {
			const found = scopes.get(scopeName);
			return found ? textmate.parseRawGrammar(await readFile(found.file, 'utf8'), found.file) : null;
		},
		theme: await loadTheme(sources),
	});
	const scopeOf = (tag: string): string | undefined => {
		const key = tag.toLowerCase();
		const id = languages.get(key) ?? byExtension.get(key);
		return id ? scopes.get(id)?.scopeName : undefined;
	};
	return { registry, scopeOf, grammars: new Map() };
}

export interface Tokenizer {
	/** The colored tokens of `text` in the language the fence tag names, or undefined for a language no installed extension has a grammar for. Default-colored text has no token. */
	tokenize(tag: string, text: string): Promise<Token[] | undefined>;
	/** Forgets the grammars and the theme, for after a change of the color theme, of its customizations or of the installed extensions. */
	reset(): void;
}

export function createTokenizer(sources: Sources): Tokenizer {
	let loaded: Promise<Loaded> | undefined;
	return {
		reset() {
			loaded = undefined;
		},
		async tokenize(tag, text) {
			if (text.length > maxLength) {
				return undefined;
			}
			const textmate = await textmateModule();
			const { registry, scopeOf, grammars } = await (loaded ??= load(sources));
			const scope = scopeOf(tag);
			if (!scope) {
				return undefined;
			}
			if (!grammars.has(scope)) {
				grammars.set(scope, registry.loadGrammar(scope));
			}
			const grammar = await grammars.get(scope);
			if (!grammar) {
				return undefined;
			}
			const colors = registry.getColorMap();
			const tokens: Token[] = [];
			let state = textmate.INITIAL;
			let offset = 0;
			for (const line of text.split('\n')) {
				const result = grammar.tokenizeLine2(line, state, 200);
				state = result.ruleStack;
				const encoded = result.tokens;
				for (let i = 0; i < encoded.length; i += 2) {
					const metadata = encoded[i + 1]!;
					const color = (metadata >>> 15) & 0x1ff; // The layout of vscode-textmate's EncodedTokenAttributes.
					if (color > 1) { // 0 is unset and 1 is the default foreground.
						tokens.push([offset + encoded[i]!, offset + (encoded[i + 2] ?? line.length), colors[color]!, (metadata >>> 11) & 0xf]);
					}
				}
				offset += line.length + 1;
			}
			return tokens;
		},
	};
}
