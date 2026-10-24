// Offline check of src/textmate.ts against a tiny fake extension in test/fixture/textmate: the
// grammar lookup by language tag, the theme files (include chain, comments, trailing commas), the
// editor.tokenColorCustomizations setting, and reset().
//
//   node test/textmate-check.ts

import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { check, finish } from './harness.ts';
import { createTokenizer, type Contributes, type Sources, type Token } from '../src/textmate.ts';

const contributes: Contributes = {
	languages: [{ id: 'tiny', aliases: ['Tiny Language', 'tl'], extensions: ['.tn'] }],
	grammars: [{ language: 'tiny', scopeName: 'source.tiny', path: './tiny.tmLanguage.json' }],
	themes: [
		{ label: 'Tiny Dark', path: './tiny-dark.json' },
		{ id: 'tiny-light-theme', label: 'Tiny Light', path: './tiny-light.json' },
	],
};

/** The settings the tokenizer reads; a test changes them between calls. */
type Settings = { theme?: string; customizations?: unknown };
const setup = (settings: Settings = { theme: 'Tiny Dark' }) => {
	const sources: Sources = {
		extensions: () => [{ path: join(import.meta.dirname, 'fixture', 'textmate'), contributes }],
		theme: () => settings.theme,
		customizations: () => settings.customizations,
	};
	return { settings, tokenizer: createTokenizer(sources) };
};

const tokensOf = async (text: string, settings?: Settings, tag = 'tiny') => {
	const tokens = await setup(settings).tokenizer.tokenize(tag, text);
	assert.ok(tokens);
	return tokens;
};
// vscode-textmate's color map returns upper-case hex, whatever case the theme file uses.
const colorsOf = (tokens: Token[]) => tokens.map(token => token[2]);

await check('a line gets the offsets and the colors of the active theme', async () => {
	assert.deepEqual(await tokensOf('if count "hi" 42'), [
		[0, 2, '#C586C0', 0],
		[9, 13, '#CE9178', 0],
		[14, 16, '#B5CEA8', 0],
	]);
});

await check('default-colored text gets no token', async () => {
	const tokens = await tokensOf('alpha if beta gamma return delta');
	assert.deepEqual(tokens, [
		[6, 8, '#C586C0', 0],
		[20, 26, '#C586C0', 0],
	]);
});

await check('a block comment that spans lines is colored on every line', async () => {
	// "a /* one" is 8 characters, so the second line starts at offset 9.
	assert.deepEqual(await tokensOf('a /* one\ntwo */ if'), [
		[2, 8, '#6A9955', 1],
		[9, 15, '#6A9955', 1],
		[16, 18, '#C586C0', 0],
	]);
});

await check('the language tag matches an ID, an alias and a file extension in any case', async () => {
	const { tokenizer } = setup();
	const expected = await tokenizer.tokenize('tiny', 'if');
	assert.deepEqual(expected, [[0, 2, '#C586C0', 0]]);
	for (const tag of ['Tiny', 'TINY', 'tl', 'TL', 'Tiny Language', 'tiny language', 'tn', 'TN']) {
		assert.deepEqual(await tokenizer.tokenize(tag, 'if'), expected, tag);
	}
});

await check('an unknown language tag gives undefined', async () => {
	const { tokenizer } = setup();
	assert.equal(await tokenizer.tokenize('nonesuch', 'if'), undefined);
	assert.equal(await tokenizer.tokenize('', 'if'), undefined);
});

await check('the theme reads its include chain, comments and trailing commas', async () => {
	const tokens = await tokensOf('if 7 "s" // c');
	// 7 is colored by tiny-base.json only; if by tiny-dark.json, which overrides the base's red.
	assert.deepEqual(colorsOf(tokens), ['#C586C0', '#B5CEA8', '#CE9178', '#6A9955']);
	assert.ok(!colorsOf(tokens).includes('#FF0000'));
});

await check('a top-level textMateRules entry and a per-theme entry change a color, and the per-theme one wins', async () => {
	const customizations = {
		textMateRules: [
			{ scope: 'keyword.control', settings: { foreground: '#ff0000' } },
			{ scope: ['string.quoted.double', 'constant.numeric'], settings: { foreground: '#00ff00' } },
		],
		'Tiny Dark': { textMateRules: [{ scope: 'keyword.control', settings: { foreground: '#0000ff' } }] },
	};
	const text = 'if "s" 1';
	const global = await tokensOf(text, { theme: 'Tiny Light', customizations });
	assert.deepEqual(colorsOf(global), ['#FF0000', '#00FF00', '#00FF00']);
	const dark = await tokensOf(text, { theme: 'Tiny Dark', customizations });
	assert.deepEqual(colorsOf(dark), ['#0000FF', '#00FF00', '#00FF00']);
});

await check('the legacy setting value "Default Tiny Dark" picks the theme named "Tiny Dark"', async () => {
	assert.deepEqual(await tokensOf('if', { theme: 'Default Tiny Dark' }), [[0, 2, '#C586C0', 0]]);
});

await check('a theme is found by its ID as well as its label', async () => {
	assert.deepEqual(await tokensOf('if', { theme: 'tiny-light-theme' }), [[0, 2, '#AF00DB', 0]]);
});

await check('reset() makes the tokenizer read the changed theme', async () => {
	const { settings, tokenizer } = setup({ theme: 'Tiny Dark' });
	assert.deepEqual(await tokenizer.tokenize('tiny', 'if'), [[0, 2, '#C586C0', 0]]);
	settings.theme = 'Tiny Light';
	assert.deepEqual(await tokenizer.tokenize('tiny', 'if'), [[0, 2, '#C586C0', 0]], 'the theme is cached until reset');
	tokenizer.reset();
	assert.deepEqual(await tokenizer.tokenize('tiny', 'if'), [[0, 2, '#AF00DB', 0]]);
});

await check('a text over 50 000 characters gives undefined', async () => {
	const { tokenizer } = setup();
	assert.deepEqual(await tokenizer.tokenize('tiny', 'if'.padEnd(50_000)), [[0, 2, '#C586C0', 0]]);
	assert.equal(await tokenizer.tokenize('tiny', 'if'.padEnd(50_001)), undefined);
});

await check('a theme no extension has gives no tokens for default-colored text and does not throw', async () => {
	assert.deepEqual(await tokensOf('plain if "s" 4', { theme: 'No Such Theme' }), []);
	assert.deepEqual(await tokensOf('plain if "s" 4', { theme: undefined }), []);
});

finish();
