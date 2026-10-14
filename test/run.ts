// End-to-end check in an isolated VS Code: downloads VS Code 1.138.0 into
// .vscode-test/, starts it with its own user-data and extensions folders and
// this extension loaded from source, then talks to the bridge through
// launcher.ts exactly as Claude Code would (stdio MCP, cwd = workspace root), through
// the shims in a fixed folder that Claude Code's config points at.
// The user's own VS Code, settings and ~/.claude.json are never touched.
//
//   node test/run.ts            (Node 22.18+), extension loaded from source
//   BRIDGE_TEST_VSIX=path\to.vsix node test/run.ts   installs that VSIX into the
//                                isolated extensions folder and tests it instead
//   BRIDGE_TEST_AUTO_APPROVE=1   turns on vscodeToolsBridge.autoApprove and the
//                                proposed API it needs; with BRIDGE_TEST_NO_CLICK=1
//                                the browser tools must then run with no dialog

import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from '@vscode/test-electron';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { discoveryFile, type DiscoveryRecord } from '../src/discovery.ts';
import { shimPaths, writeShims } from '../src/shims.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const run = join(root, '.vscode-test', 'run');
const workspace = join(run, 'workspace');
const discovery = join(run, 'discovery');
process.env['VSCODE_TOOLS_BRIDGE_DIR'] = discovery;

rmSync(run, { recursive: true, force: true });
mkdirSync(join(run, 'user-data', 'User'), { recursive: true });
mkdirSync(join(run, 'extensions'), { recursive: true });
cpSync(join(root, 'test', 'fixture'), workspace, { recursive: true });
// A workspace that empties the user's deny list, as a cloned repo's .vscode/settings.json could. The deny list is in the user settings below.
mkdirSync(join(workspace, '.vscode'));
writeFileSync(join(workspace, '.vscode', 'settings.json'), JSON.stringify({ 'vscodeToolsBridge.executeCommand.deny': [] }));
const autoApprove = !!process.env['BRIDGE_TEST_AUTO_APPROVE'];
const settingsFile = join(run, 'user-data', 'User', 'settings.json');
// Settings a check turns on or off while the window runs.
const overrides: Record<string, unknown> = {};
const writeSettings = (enabled: boolean) => writeFileSync(settingsFile, JSON.stringify({
	'security.workspace.trust.enabled': false,
	'update.mode': 'none',
	'telemetry.telemetryLevel': 'off',
	'workbench.startupEditor': 'none',
	'workbench.editor.closeEmptyGroups': false, // The bridge's startup panel must leave no empty group behind.
	'extensions.confirmedUriHandlerExtensionIds': ['local.vscode-tools-bridge'], // Skips the prompt that a link to an extension raises.
	'workbench.editorAssociations': { '*.md': 'vscode.markdown.editor' },
	'chat.agent.enabled': true,
	'workbench.browser.enableChatTools': true,
	'vscodeToolsBridge.executeCommand.deny': ['workbench.action.quit'],
	'vscodeToolsBridge.enabled': enabled,
	'vscodeToolsBridge.autoApprove': autoApprove,
	...overrides,
}, null, 2));
// Start disabled, to check the bridge stays off until the setting is turned on.
writeSettings(false);

// A page for the browser tools.
const page = createServer((_req, res) => {
	res.setHeader('content-type', 'text/html');
	res.end('<title>Bridge test</title><h1 id="h">Before</h1><button onclick="document.getElementById(\'h\').textContent=\'After\'">Press me</button><input id="q" aria-label="Query">');
});
await new Promise<void>(r => page.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${(page.address() as AddressInfo).port}/`;

const exe = await downloadAndUnzipVSCode({ version: '1.138.0', cachePath: join(root, '.vscode-test') });
// Drop variables inherited from a VS Code or Claude Code parent so the test
// instance cannot mistake itself for a CLI call into the user's running VS Code.
const env: NodeJS.ProcessEnv = {};
for (const [k, v] of Object.entries(process.env)) {
	if (!/^(VSCODE_|ELECTRON_)/.test(k) || k === 'VSCODE_TOOLS_BRIDGE_DIR') {
		env[k] = v;
	}
}
// The Connect command writes Claude Code's config; this folder keeps it away from the user's own.
const claudeConfig = join(run, 'claude-config');
mkdirSync(claudeConfig, { recursive: true });
env['CLAUDE_CONFIG_DIR'] = claudeConfig;
// An old registration: the Connect check must replace it, and the extension offers no connection while one exists.
writeFileSync(join(claudeConfig, '.claude.json'), JSON.stringify({ mcpServers: { 'vscode-tools': { type: 'stdio', command: 'node', args: ['/old/clone/launcher.ts'], env: {} } } }));
const vsix = process.env['BRIDGE_TEST_VSIX'];
if (vsix) {
	// Keep the CLI script path but replace its default user-data and extensions folders with ours.
	const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(exe).filter(a => !/^--(user-data|extensions)-dir=/.test(a));
	const installed = spawnSync(cli!, [...cliArgs, `--user-data-dir=${join(run, 'user-data')}`, `--extensions-dir=${join(run, 'extensions')}`, '--install-extension', vsix], { env, encoding: 'utf8', shell: process.platform === 'win32' });
	console.log(installed.stdout, installed.stderr);
}
const code = spawn(exe, [
	workspace,
	join(workspace, 'src', 'greet.ts'), // An open editor, as after a reload: a panel opened beside it would add a group.
	...(vsix ? [] : [`--extensionDevelopmentPath=${root}`]),
	`--extensionDevelopmentPath=${join(root, 'test', 'standin')}`, // Plays Claude Code's chat webview.
	`--user-data-dir=${join(run, 'user-data')}`,
	`--extensions-dir=${join(run, 'extensions')}`,
	'--disable-workspace-trust',
	'--skip-welcome',
	'--skip-release-notes',
	'--new-window',
	...(autoApprove ? ['--enable-proposed-api=local.vscode-tools-bridge'] : []),
	...(process.env['BRIDGE_TEST_TRACE'] ? ['--log=trace'] : []),
], { env, stdio: 'ignore' });

// test/window-helper.ps1 keeps the test window out of the user's way and
// answers the confirmation dialogs that tokenless tool calls raise, touching
// only windows of this instance's main process. BRIDGE_TEST_WINDOW picks how
// the window is kept away: offscreen (default; stays rendered, which
// Playwright's click needs), minimize (the page stops rendering and
// click_element times out) or none.
// BRIDGE_TEST_NO_CLICK=1 leaves dialogs for a person (or the 15 s timeout).
const dialogLog = join(run, 'window-helper.log');
const clicker = process.platform === 'win32' && code.pid
	? spawn('powershell.exe', [
		'-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'test', 'window-helper.ps1'),
		'-ProcessId', String(code.pid), '-LogFile', dialogLog,
		'-Hide', process.env['BRIDGE_TEST_WINDOW'] ?? 'offscreen',
		...(process.env['BRIDGE_TEST_NO_CLICK'] ? ['-NoClick'] : []),
	], { stdio: ['ignore', 'ignore', 'pipe'] })
	: undefined;
let clickerErrors = '';
clicker?.stderr?.on('data', d => { clickerErrors += String(d); });

const results: { name: string; ok: boolean; note: string }[] = [];
let client: Client | undefined;

// Runs prompt-hook.ts the way Claude Code runs a UserPromptSubmit hook: a
// fresh process, the hook payload as JSON on stdin, cwd in the payload.
const runHook = (cwd: string, surface: 'chip' | 'cli' | 'cli-without-vscode' = 'chip') => {
	const started = Date.now();
	const out = spawnSync(process.execPath, [shimPaths().hook], {
		input: JSON.stringify({ session_id: 'test', transcript_path: '', cwd, permission_mode: 'default', hook_event_name: 'UserPromptSubmit', prompt: 'What is on the page?' }),
		// The chat panel's process has the entrypoint claude-vscode; a CLI in a VS Code terminal has cli and VS Code's port variable.
		env: { ...env, CLAUDE_CODE_ENTRYPOINT: surface === 'chip' ? 'claude-vscode' : 'cli', ...(surface === 'cli' ? { CLAUDE_CODE_SSE_PORT: '1' } : {}) },
		encoding: 'utf8', timeout: 5000,
	});
	return { stdout: out.stdout, stderr: out.stderr, status: out.status, ms: Date.now() - started };
};
const hookContext = (stdout: string): string | undefined => {
	try {
		return (JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext;
	} catch {
		return undefined;
	}
};
// Presses a workbench button by accessible name, in the test instance only.
const pressButton = (name: string) => spawnSync('powershell.exe', [
	'-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'test', 'window-helper.ps1'),
	'-ProcessId', String(code.pid), '-LogFile', join(run, 'invoke.log'), '-InvokeButton', name,
], { encoding: 'utf8', timeout: 30_000 }).stdout.trim();
try {
	const file = discoveryFile(workspace);
	// Off while the setting is off: wait for the extension to log that it stayed off, check
	// it wrote no discovery file, then turn it on the way a user would.
	const logsDir = join(run, 'user-data', 'logs');
	const bridgeLog = (): string => {
		const walk = (dir: string): string => readdirSync(dir, { withFileTypes: true }).map(e =>
			e.isDirectory() ? walk(join(dir, e.name)) : e.name === 'VS Code Bridge for Claude Code.log' ? readFileSync(join(dir, e.name), 'utf8') : '').join('');
		return existsSync(logsDir) ? walk(logsDir) : '';
	};
	for (let i = 0; i < 180 && !/enabled is off/.test(bridgeLog()); i++) {
		await new Promise(r => setTimeout(r, 500));
	}
	{
		const h = runHook(workspace);
		results.push({ name: 'prompt hook, bridge off', ok: h.status === 0 && h.stdout === '', note: `exit ${h.status}, ${h.stdout.length} bytes, ${h.ms} ms` });
	}
	results.push({ name: 'off while disabled', ok: /enabled is off/.test(bridgeLog()) && !existsSync(file), note: existsSync(file) ? 'discovery file exists while disabled' : 'logged "enabled is off", no discovery file' });
	writeSettings(true);
	for (let i = 0; i < 180 && !existsSync(file); i++) {
		await new Promise(r => setTimeout(r, 500));
	}
	if (!existsSync(file)) {
		throw new Error(`No discovery file at ${file} after 90 s`);
	}
	const record = JSON.parse(readFileSync(file, 'utf8')) as DiscoveryRecord;
	console.log(`Bridge up: ${record.pipe}`);

	// A client without the token must be dropped before it gets any MCP reply.
	const rejected = await new Promise<string>(resolve => {
		const s = connect(record.pipe, () => s.write('wrong-token\n{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n'));
		let got = '';
		s.on('data', d => { got += String(d); });
		s.on('close', () => resolve(got));
		s.on('error', () => resolve(got));
	});
	results.push({ name: 'token check', ok: rejected === '', note: rejected ? `got reply: ${rejected.slice(0, 80)}` : 'connection closed, no reply' });

	client = new Client({ name: 'bridge-test', version: '0' });
	await client.connect(new StdioClientTransport({ command: process.execPath, args: [shimPaths().launcher], cwd: workspace, env: env as Record<string, string>, stderr: 'inherit' }));
	const { tools } = await client.listTools();
	console.log(`Tools (${tools.length}): ${tools.map(t => t.name).join(', ')}`);

	const call = async (name: string, args: Record<string, unknown>, timeoutMs = 45_000): Promise<CallToolResult> =>
		await client!.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs }) as CallToolResult;
	const textOf = (r: CallToolResult) => r.content.map(c => c.type === 'text' ? c.text : `[${c.type}${c.type === 'image' ? ` ${c.mimeType}, ${c.data.length} base64 chars` : ''}]`).join('\n');
	const check = async (name: string, fn: () => Promise<string | true>) => {
		try {
			const r = await fn();
			results.push({ name, ok: r === true, note: r === true ? '' : r });
		} catch (e) {
			results.push({ name, ok: false, note: e instanceof Error ? e.message : String(e) });
		}
	};
	const expectText = async (name: string, tool: string, args: Record<string, unknown>, pattern: RegExp, timeoutMs?: number) => {
		await check(name, async () => {
			const r = await call(tool, args, timeoutMs);
			const t = textOf(r);
			console.log(`\n--- ${name} (${tool}) ---\n${t.slice(0, 1500)}`);
			return !r.isError && pattern.test(t) ? true : `isError=${!!r.isError}: ${t.slice(0, 300)}`;
		});
	};
	const has = (n: string) => tools.some(t => t.name === n);
	// The selections the stand-in's text editor selection listener got for notes.md: what the CLI would get.
	const cliSelections = async () => (JSON.parse(textOf(await call('execute_command', { command: 'standin.selections' }))) as { uri: string; text: string }[]).filter(s => s.uri.endsWith('notes.md'));
	await check('the bridge starts with the layout it found', async () => {
		const groups = textOf(await call('execute_command', { command: 'standin.groupCount' }));
		return groups === '1' || `${groups} editor groups`;
	});

	await check('server instructions name only tools the bridge serves', async () => {
		const text = client!.getInstructions() ?? '';
		const browserTools = ['shared_browser_pages', 'open_browser_page', 'screenshot_page', 'run_playwright_code'];
		const named = [...new Set(text.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [])];
		const missing = named.filter(n => !has(n) && (has('list_browser_pages') || !browserTools.includes(n)));
		if (!text || text.length > 4096) {
			return `${text.length} characters; Claude Code cuts them at 4096`;
		}
		return named.includes('execute_command') && missing.length === 0 || `names ${named.join(', ')}; not served: ${missing.join(', ')}`;
	});
	await expectText('list_workspaces', 'list_workspaces', {}, /"folders"[\s\S]*workspace/);
	await expectText('get_diagnostics finds the type error', 'get_diagnostics', { paths: ['src/broken.ts'], minSeverity: 'error', waitMs: 20_000 }, /broken\.ts:1:\d+ error \[ts/, 60_000);
	await expectText('rename_symbol', 'rename_symbol', { path: 'src/greet.ts', line: 1, symbol: 'oldName', newName: 'newGreeting' }, /2 file\(s\)/, 60_000);
	await check('rename reached disk', async () => readFileSync(join(workspace, 'src', 'use.ts'), 'utf8').includes('newGreeting(') || 'use.ts not updated');
	await expectText('execute_command returns serialised objects', 'execute_command', { command: 'vscode.executeDocumentSymbolProvider', args: [{ $uri: 'src/greet.ts' }] }, /newGreeting[\s\S]*"line"/);
	await check('execute_command deny list', async () => {
		const r = await call('execute_command', { command: 'workbench.action.quit' });
		return r.isError && /blocked/.test(textOf(r)) ? true : textOf(r);
	});
	await expectText('list_commands', 'list_commands', { filter: 'editor.action.formatDocument' }, /editor\.action\.formatDocument/);
	await expectText('open_files', 'open_files', { paths: ['src/use.ts:3'] }, /use\.ts/);
	await expectText('visible_images, text tab in front', 'visible_images', {}, /No image files/);
	{
		// A 1×1 PNG; vscode.open shows it in the image preview, as a click in the explorer does.
		writeFileSync(join(workspace, 'shot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
		await call('execute_command', { command: 'vscode.open', args: [{ $uri: 'shot.png' }] });
		await new Promise(r => setTimeout(r, 2000));
		await expectText('visible_images sees the image preview', 'visible_images', {}, /shot\.png \(active\)/);
		const h = runHook(workspace);
		const context = hookContext(h.stdout) ?? '';
		results.push({ name: 'prompt hook reports the image', ok: h.status === 0 && /shot\.png \(active\)/.test(context) && /Read tool/.test(context), note: `${h.ms} ms` });
		await call('execute_command', { command: 'workbench.action.closeActiveEditor' });
	}
	{
		await expectText('markdown_editor_selection, no Markdown Editor in front', 'markdown_editor_selection', {}, /No Markdown Editor is in front/);
		// The built-in Markdown Editor has no selection API; the bridge reads it from the page.
		const notes = readFileSync(join(workspace, 'notes.md'), 'utf8');
		await call('execute_command', { command: 'vscode.openWith', args: [{ $uri: 'notes.md' }, 'vscode.markdown.editor'] });
		const selectionNow = async () => textOf(await call('markdown_editor_selection', {}));
		const until = async (done: (t: string) => boolean, ms = 20_000): Promise<string> => {
			let t = await selectionNow();
			for (const end = Date.now() + ms; !done(t) && Date.now() < end; t = await selectionNow()) {
				await new Promise(r => setTimeout(r, 500));
			}
			return t;
		};
		await call('execute_command', { command: 'markdown.editor.selectAll' });
		const all = await until(t => t.includes('selected text:'));
		console.log(`\n--- markdown_editor_selection after selectAll ---\n${all}`);
		const lines = notes.split('\n').length - 1;
		await check('markdown_editor_selection returns the selected text and lines', async () =>
			all.includes(`notes.md (active), lines 1-${lines}`) && all.includes(`selected text:\n\`\`\`\n${notes}\n\`\`\``) || all.slice(0, 300));
		const h = runHook(workspace);
		const context = hookContext(h.stdout) ?? '';
		results.push({ name: 'prompt hook reports the selection', ok: h.status === 0 && context.includes(`lines 1-${lines}`) && context.includes('selected text:') && context.includes('Second paragraph.') && /Markdown Editor/.test(context), note: `${h.ms} ms` });
		// The CLI gets a selection from the listeners Claude Code registers for text editors.
		await check('Claude Code CLI listener receives the selection', async () => {
			const got = await cliSelections();
			return got.some(s => s.text === notes) || JSON.stringify(got).slice(0, 300);
		});
		{
			const forCli = runHook(workspace, 'cli');
			results.push({ name: 'prompt hook skips the selection for a CLI that got it', ok: forCli.status === 0 && !(hookContext(forCli.stdout) ?? '').includes('Markdown Editor'), note: `${forCli.ms} ms` });
			const unconnected = runHook(workspace, 'cli-without-vscode');
			results.push({ name: 'prompt hook reports the selection to a CLI outside VS Code', ok: (hookContext(unconnected.stdout) ?? '').includes('Second paragraph.'), note: `${unconnected.ms} ms` });
		}
		await call('execute_command', { command: 'markdown.editor.cursorDocumentEnd' });
		const cursor = await until(t => !t.includes('selected text:'));
		console.log(`\n--- markdown_editor_selection after cursorDocumentEnd ---\n${cursor}`);
		await check('markdown_editor_selection reports the cursor line when nothing is selected', async () =>
			/notes\.md \(active\): nothing selected, cursor on line \d+\./.test(cursor) || cursor.slice(0, 300));
		const quiet = runHook(workspace);
		results.push({ name: 'prompt hook adds nothing for a cursor', ok: quiet.status === 0 && !(hookContext(quiet.stdout) ?? '').includes('Markdown Editor'), note: `${quiet.ms} ms` });
		// Claude Code's selection chip. A stand-in extension (test/standin) plays its chat webview: it posts a
		// from-extension message, which is how the bridge finds the webview, and records what it receives.
		await call('execute_command', { command: 'standin.open' });
		type Posted = { request?: { type?: string; selection?: { filePath: string; startLine: number; endLine: number; selectedText?: string } } };
		const standinMessages = async (): Promise<Posted[]> =>
			(JSON.parse(textOf(await call('execute_command', { command: 'standin.received' }))) as { message?: Posted }[]).flatMap(m => m.message ? [m.message] : []);
		const selectionPosts = async (done: (n: number) => boolean) => {
			let posts: Posted[] = [];
			for (const end = Date.now() + 20_000; Date.now() < end; await new Promise(r => setTimeout(r, 500))) {
				posts = (await standinMessages()).filter(m => m.request?.type === 'selection_changed');
				if (done(posts.length)) {
					break;
				}
			}
			return posts;
		};
		await check('stand-in webview is live', async () => {
			for (const end = Date.now() + 20_000; Date.now() < end; await new Promise(r => setTimeout(r, 500))) {
				if ((await standinMessages()).some(m => m.request?.type === 'focus_input')) {
					return true;
				}
			}
			return 'the stand-in received no message';
		});
		await call('execute_command', { command: 'markdown.editor.selectAll' });
		const chipPosts = await selectionPosts(n => n > 0);
		const posted = chipPosts.at(-1)?.request?.selection; // As for a text editor, endLine is the line holding the selection's end, here the empty line after the last newline.
		await check('Claude Code webview receives the selection', async () =>
			posted?.selectedText === notes && posted.startLine === 1 && posted.endLine === lines + 1 && /notes\.md$/.test(posted.filePath) || JSON.stringify(chipPosts).slice(0, 300));
		const delivered = await until(t => t.includes('selection chip'));
		await check('markdown_editor_selection marks the delivered selection', async () => /lines 1-\d+, shown in Claude Code's selection chip[^\n]*selected text:/.test(delivered) || delivered.slice(0, 300));
		const skipped = runHook(workspace);
		results.push({ name: 'prompt hook skips a selection the chip shows', ok: skipped.status === 0 && !(hookContext(skipped.stdout) ?? '').includes('Markdown Editor'), note: `${skipped.ms} ms` });
		await call('execute_command', { command: 'markdown.editor.cursorDocumentEnd' });
		const cursorPosts = await selectionPosts(n => n > chipPosts.length);
		await check('a cursor reaches Claude Code as a line', async () => {
			const c = cursorPosts.at(-1)?.request?.selection;
			return cursorPosts.length > chipPosts.length && c?.startLine === lines + 1 && c.endLine === lines + 1 && c.selectedText === undefined || JSON.stringify(cursorPosts.at(-1)).slice(0, 300);
		});
		// Focus the stand-in's group and come back: Claude Code may have cleared its chip meanwhile.
		await call('execute_command', { command: 'markdown.editor.selectAll' });
		const beforeRefocus = (await selectionPosts(n => n > cursorPosts.length)).length;
		await call('execute_command', { command: 'workbench.action.focusSecondEditorGroup' });
		await call('execute_command', { command: 'workbench.action.focusFirstEditorGroup' });
		const refocused = await selectionPosts(n => n > beforeRefocus);
		await check('a Markdown Editor coming to the front sends its selection again', async () =>
			refocused.length > beforeRefocus && refocused.at(-1)?.request?.selection?.selectedText === notes || `${beforeRefocus} -> ${refocused.length} posts`);
		await call('execute_command', { command: 'standin.close' });
		await call('execute_command', { command: 'workbench.action.closeActiveEditor' });
		await expectText('markdown_editor_selection, editor closed', 'markdown_editor_selection', {}, /No Markdown Editor is in front/);
	}

	{
		// Chat links. Claude Code (here the stand-in) opens a link with showTextDocument(uri) and falls back to
		// vscode.open only when that rejects; the bridge makes it reject for a file that opens in a custom editor.
		const tab = async () => JSON.parse(textOf(await call('execute_command', { command: 'standin.activeTab' }))) as { kind: string; viewType?: string; uri?: string };
		const openLink = async (file: string) => textOf(await call('execute_command', { command: 'standin.openLink', args: [{ $uri: file }] })).replace(/^"|"$/g, '');
		for (const [file, route, kind, viewType] of [
			['notes.md', 'vscode.open', 'custom', 'vscode.markdown.editor'],
			['src/use.ts', 'showTextDocument', 'text', undefined],
		] as const) {
			await check(`chat link to ${file} opens through ${route}`, async () => {
				const via = await openLink(file);
				await new Promise(r => setTimeout(r, 1500));
				const t = await tab();
				await call('execute_command', { command: 'workbench.action.closeActiveEditor' });
				return via === route && t.kind === kind && (t.viewType ?? undefined) === viewType && t.uri?.endsWith(file.replace('/', '\\')) || `via ${via}, tab ${JSON.stringify(t)}`;
			});
		}
		await check('showTextDocument with a TextDocument is not rejected', async () => {
			const result = textOf(await call('execute_command', { command: 'standin.showDocument', args: [{ $uri: 'notes.md' }] })).replace(/^"|"$/g, '');
			await new Promise(r => setTimeout(r, 1500));
			const t = await tab();
			await call('execute_command', { command: 'workbench.action.closeActiveEditor' });
			return result === 'shown' && t.kind === 'text' || `${result}, tab ${JSON.stringify(t)}`;
		});

		// Each patch has its own setting, which takes effect without a reload.
		const setSetting = async (key: string, value: boolean) => {
			overrides[`vscodeToolsBridge.${key}`] = value;
			writeSettings(true);
			for (const end = Date.now() + 30_000; Date.now() < end; await new Promise(r => setTimeout(r, 500))) {
				if (textOf(await call('execute_command', { command: 'standin.setting', args: [key] })) === String(value)) {
					break;
				}
			}
			await new Promise(r => setTimeout(r, 1000));
		};
		const followLink = async (file: string) => {
			const via = await openLink(file);
			await new Promise(r => setTimeout(r, 1500));
			const t = await tab();
			await call('execute_command', { command: 'workbench.action.closeActiveEditor' });
			return `${via}, ${t.kind}`;
		};
		await setSetting('claudeCode.chatLinks', false);
		await check('chat links off: a link to the .md opens as text', async () => {
			const opened = await followLink('notes.md');
			return opened === 'showTextDocument, text' || opened;
		});
		await setSetting('claudeCode.chatLinks', true);
		await check('chat links on again: the link opens in the Markdown Editor', async () => {
			const opened = await followLink('notes.md');
			return opened === 'vscode.open, custom' || opened;
		});

		const postsToClaude = async () => (JSON.parse(textOf(await call('execute_command', { command: 'standin.received' }))) as { message?: { request?: { type?: string } } }[])
			.filter(m => m.message?.request?.type === 'selection_changed').length;
		const selectAllInMarkdownEditor = async () => {
			await call('execute_command', { command: 'vscode.openWith', args: [{ $uri: 'notes.md' }, 'vscode.markdown.editor'] });
			await new Promise(r => setTimeout(r, 3000));
			await call('execute_command', { command: 'markdown.editor.selectAll' });
			await new Promise(r => setTimeout(r, 3000));
		};
		await setSetting('markdownEditor.selection', false);
		await call('execute_command', { command: 'standin.open' });
		await new Promise(r => setTimeout(r, 3000));
		const postsBefore = await postsToClaude();
		const cliBefore = (await cliSelections()).length;
		await selectAllInMarkdownEditor();
		await check('Markdown Editor selection off: the tool reads nothing', async () => {
			const t = textOf(await call('markdown_editor_selection', {}));
			return /not being read/.test(t) || t.slice(0, 300);
		});
		await check('Markdown Editor selection off: nothing reaches Claude Code', async () => {
			const after = await postsToClaude();
			const cliAfter = (await cliSelections()).length;
			return after === postsBefore && cliAfter === cliBefore || `${postsBefore} -> ${after} chip posts, ${cliBefore} -> ${cliAfter} CLI selections`;
		});
		{
			const h = runHook(workspace);
			results.push({ name: 'Markdown Editor selection off: the prompt hook adds nothing', ok: h.status === 0 && !(hookContext(h.stdout) ?? '').includes('Markdown Editor'), note: `${h.ms} ms` });
		}
		await call('execute_command', { command: 'workbench.action.closeActiveEditor' });
		await call('execute_command', { command: 'standin.close' });
		await setSetting('markdownEditor.selection', true);
		await call('execute_command', { command: 'standin.open' }); // Its first post lets the bridge find it again.
		await new Promise(r => setTimeout(r, 3000));
		await selectAllInMarkdownEditor();
		await check('Markdown Editor selection on again: the tool and Claude Code get the selection', async () => {
			const t = textOf(await call('markdown_editor_selection', {}));
			const after = await postsToClaude();
			return /lines 1-\d+, shown in Claude Code's selection chip[^\n]*selected text:/.test(t) && after > postsBefore || `${t.slice(0, 200)}; ${postsBefore} -> ${after} posts`;
		});
		await call('execute_command', { command: 'workbench.action.closeActiveEditor' });
		await call('execute_command', { command: 'standin.close' });

		// The README's setting links reach the bridge as vscode:// links; --open-url hands one to this test instance only.
		const openSettingsLink = (url: string) => spawnSync(exe, ['--open-url', url, `--user-data-dir=${join(run, 'user-data')}`, `--extensions-dir=${join(run, 'extensions')}`], { env, timeout: 30_000 });
		const activeLabel = async () => (await tab() as { label?: string }).label;
		const waitForLabel = async (label: string) => {
			for (const end = Date.now() + 15_000; Date.now() < end; await new Promise(r => setTimeout(r, 500))) {
				if (await activeLabel() === label) {
					return true;
				}
			}
			return false;
		};
		openSettingsLink('vscode://local.vscode-tools-bridge/settings?id=vscodeToolsBridge.enabled&url=vscode%3A%2F%2Flocal.vscode-tools-bridge%2Fsettings%3Fid%3DvscodeToolsBridge.enabled');
		results.push({ name: 'a setting link opens the Settings editor', ok: await waitForLabel('Settings'), note: `active tab: ${await activeLabel()}` });
		await call('execute_command', { command: 'workbench.action.closeActiveEditor' });
		openSettingsLink('vscode://local.vscode-tools-bridge/settings?id=workbench.colorTheme');
		await new Promise(r => setTimeout(r, 5000));
		results.push({ name: 'a link to another extension\'s setting is ignored', ok: await activeLabel() !== 'Settings' && /Ignored the link/.test(bridgeLog()), note: `active tab: ${await activeLabel()}` });
	}

	// The shims: the extension wrote them when it started, and every connection above ran through them.
	{
		const shims = shimPaths();
		const dir = dirname(shims.launcher);
		const shimText = (file: string) => readFileSync(join(dir, file), 'utf8');
		// VS Code may write the drive letter in lower case.
		const loads = (file: string, target: string) => shimText(file).toLowerCase().includes(pathToFileURL(join(root, target)).href.toLowerCase());
		results.push({ name: 'the extension wrote the launcher and hook shims', ok: loads('launcher.mjs', 'launcher.ts') && loads('prompt-hook.mjs', 'prompt-hook.ts'), note: dir });
		// What setup.ts writes for a clone, in a throwaway folder: complete, then left alone, then repaired.
		const clone = join(run, 'clone-shims');
		const first = writeShims(root, clone);
		const second = writeShims(root, clone);
		writeFileSync(join(clone, 'launcher.mjs'), 'edited');
		const third = writeShims(root, clone);
		results.push({ name: 'writeShims writes a clone once and repairs a changed file', ok: first.length === 2 && second.length === 0 && third.join() === 'launcher.mjs' && readFileSync(join(clone, 'launcher.mjs'), 'utf8').includes(pathToFileURL(join(root, 'launcher.ts')).href), note: `${first.length} written, then ${second.length}, then ${third.join()}` });
	}

	{
		// Connect Claude Code, against the throwaway Claude Code config folder. The modal is answered like the other dialogs.
		const settings = join(claudeConfig, 'settings.json');
		const entry = (command: string) => ({ hooks: [{ type: 'command', command }] });
		writeFileSync(settings, JSON.stringify({ theme: 'dark', hooks: { UserPromptSubmit: [entry('node "/old/clone/prompt-hook.ts"'), entry('echo unrelated')] } }));
		const connected = await call('execute_command', { command: 'vscodeToolsBridge.connectClaudeCode' }, 90_000);
		console.log(`\n--- Connect Claude Code ---\n${textOf(connected)}`);
		await check('Connect Claude Code registers the MCP server', async () => {
			const server = (JSON.parse(readFileSync(join(claudeConfig, '.claude.json'), 'utf8')) as { mcpServers?: Record<string, { command?: string; args?: string[] }> }).mcpServers?.['vscode-tools'];
			return server?.command === 'node' && server.args?.join() === shimPaths().launcher || JSON.stringify(server);
		});
		await check('Connect Claude Code replaces the hook entry and keeps the rest', async () => {
			const saved = JSON.parse(readFileSync(settings, 'utf8')) as { theme?: string; hooks?: { UserPromptSubmit?: { hooks: { command: string }[] }[] } };
			const commands = saved.hooks?.UserPromptSubmit?.flatMap(e => e.hooks.map(h => h.command)) ?? [];
			return saved.theme === 'dark' && commands.join('|') === `echo unrelated|node "${shimPaths().hook}"` || JSON.stringify(saved).slice(0, 300);
		});
	}

	// Terminal: run a command through the keyboard-input command, then read it back.
	await check('terminal setup', async () => {
		await call('execute_command', { command: 'workbench.action.terminal.new' });
		await new Promise(r => setTimeout(r, 8000));
		await call('execute_command', { command: 'workbench.action.terminal.sendSequence', args: [{ text: 'echo bridge-marker-42\r' }] });
		await new Promise(r => setTimeout(r, 4000));
		return true;
	});
	if (has('terminal_last_command')) {
		await expectText('terminal_last_command', 'terminal_last_command', {}, /bridge-marker-42/);
	}
	if (has('terminal_selection')) {
		await call('execute_command', { command: 'workbench.action.terminal.selectAll' });
		await expectText('terminal_selection', 'terminal_selection', {}, /bridge-marker-42/);
	}
	for (const name of ['semantic_search', 'vscode_api_reference']) {
		if (has(name)) {
			await expectText(name, name, { query: name === 'semantic_search' ? 'greeting function' : 'registerCommand' }, /\S/, 60_000);
		}
	}

	// Browser. The page tools only see pages the agent opened with
	// open_browser_page or that the user shared, and a page opened by command is
	// not shared. open_browser_page, navigate_page and run_playwright_code ask for
	// confirmation, which a tokenless call turns into a native modal dialog;
	// window-helper.ps1 answers it. Those calls get 15 s, and a timeout is
	// reported as waiting on the dialog, not as a failure.
	const dialogTools: string[] = [];
	const tryConfirming = async (name: string, args: Record<string, unknown>, pattern: RegExp): Promise<string | undefined> => {
		try {
			const t = textOf(await call(name, args, 15_000));
			console.log(`\n--- ${name} (answered) ---\n${t.slice(0, 600)}`);
			results.push({ name, ok: pattern.test(t), note: autoApprove ? 'auto-approved' : 'confirmation dialog was answered' });
			return t;
		} catch (e) {
			if (/timed out/i.test(String(e))) {
				dialogTools.push(name);
			} else {
				results.push({ name, ok: false, note: String(e) });
			}
			return undefined;
		}
	};
	if (has('list_browser_pages')) {
		await expectText('list_browser_pages (empty)', 'list_browser_pages', {}, /No browser pages/);
		{
			const h = runHook(workspace);
			results.push({ name: 'prompt hook, nothing shared', ok: h.status === 0 && h.stdout === '', note: `exit ${h.status}, ${h.stdout.length} bytes, ${h.ms} ms` });
		}
		const opened = await tryConfirming('open_browser_page', { url: pageUrl }, /Page ID/);
		const pageId = opened && /Page ID: ([0-9a-f-]{36})/i.exec(opened)?.[1];
		if (pageId) {
			// The page opens in a background tab and Playwright only clicks visible
			// elements, so bring it to the front.
			await call('execute_command', { command: 'workbench.action.lastEditorInGroup' });
			await expectText('list_browser_pages', 'list_browser_pages', {}, new RegExp(pageId));
			await expectText('read_page', 'read_page', { pageId }, /Before/);
			await check('screenshot_page returns an image', async () => {
				const r = await call('screenshot_page', { pageId });
				return r.content.some(c => c.type === 'image') ? true : textOf(r).slice(0, 300);
			});
			// Browser tools report their own failures as text, not as MCP errors,
			// so each action is checked by reading the page afterwards.
			await call('click_element', { pageId, selector: 'button', element: 'Press me button' });
			await expectText('click_element changed the page', 'read_page', { pageId }, /After/);
			await call('type_in_page', { pageId, selector: '#q', text: 'typed-by-bridge', element: 'Query box' });
			await expectText('type_in_page reached the page', 'read_page', { pageId }, /typed-by-bridge/);
			await expectText('hover_element', 'hover_element', { pageId, selector: 'button', element: 'Press me button' }, /Page Title/);
			await tryConfirming('run_playwright_code', { pageId, code: 'return await page.title();' }, /Bridge test/);
			await tryConfirming('navigate_page', { pageId, type: 'url', url: `${pageUrl}?second` }, /\?second/);
		}
	}
	// A page the user opens and then shares with the toolbar's "Share with Agent"
	// button, the way a person does it. The first share asks "Share with
	// Agent?" (Allow/Deny), which window-helper.ps1 answers with Allow.
	if (has('shared_browser_pages') && process.platform === 'win32') {
		const userUrl = `${pageUrl}?shared-by-user`;
		// The page counts as shared when it is in the listing's first section,
		// "…currently shared with you…", which ends at the first blank line.
		const isShared = async () => {
			const first = textOf(await call('list_browser_pages', {})).split('\n\n')[0] ?? '';
			return first.includes('currently shared with you') && first.includes('shared-by-user');
		};
		// Polls the sharing state for a while and logs every change, so a
		// button press that toggles more than once shows up.
		const watchSharing = async (label: string, ms: number): Promise<boolean> => {
			const started = Date.now();
			let last: boolean | undefined;
			const changes: string[] = [];
			while (Date.now() - started < ms) {
				const now = await isShared();
				if (now !== last) {
					changes.push(`${Date.now() - started} ms: ${now ? 'shared' : 'not shared'}`);
					last = now;
				}
				await new Promise(r => setTimeout(r, 300));
			}
			console.log(`
${label}: ${changes.join(', ')}`);
			return !!last;
		};
		await call('execute_command', { command: 'workbench.action.browser.open', args: [userUrl] });
		await new Promise(r => setTimeout(r, 3000));
		const before = runHook(workspace);
		results.push({ name: 'prompt hook ignores an unshared page', ok: !(hookContext(before.stdout) ?? '').includes('shared-by-user'), note: `${before.ms} ms` });
		const pressed = pressButton('Share with Agent');
		results.push({ name: 'toolbar Share with Agent button found', ok: pressed.startsWith('pressed'), note: pressed });
		results.push({ name: 'page shared after Share with Agent + Allow', ok: await watchSharing('sharing state after Share with Agent', 6000), note: '' });
		await expectText('list_browser_pages sees the user-shared page', 'list_browser_pages', {}, /shared with you[\s\S]*shared-by-user/);
		await expectText('shared_browser_pages returns it with a snapshot', 'shared_browser_pages', {}, /shared-by-user[\s\S]*Page ID: [0-9a-f-]{36}[\s\S]*heading "(Before|After)"/);
		const after = runHook(workspace);
		const context = hookContext(after.stdout);
		console.log(`
--- prompt hook output (${after.ms} ms) ---
${after.stdout}`);
		results.push({ name: 'prompt hook reports the user-shared page', ok: after.status === 0 && !!context && /shared-by-user/.test(context) && /Page ID: [0-9a-f-]{36}/.test(context), note: `${after.ms} ms` });
		results.push({ name: 'prompt hook under 1 s', ok: after.ms < 1000, note: `${after.ms} ms` });
		const sub = runHook(join(workspace, 'src'));
		results.push({ name: 'prompt hook from a subfolder', ok: /shared-by-user/.test(hookContext(sub.stdout) ?? ''), note: `${sub.ms} ms` });
		// Unsharing needs no confirmation; the button is now labelled for it.
		const unpressed = pressButton('Stop Sharing with Agent');
		const stillShared = await watchSharing('sharing state after Stop Sharing with Agent', 5000);
		const unshared = runHook(workspace);
		results.push({ name: 'unshare with the same button', ok: unpressed.startsWith('pressed') && !stillShared && !(hookContext(unshared.stdout) ?? '').includes('shared-by-user'), note: unpressed });
	}
	for (const name of dialogTools) {
		// With auto-approve on, a dialog should never appear, so waiting is a failure.
		results.push({ name, ok: !autoApprove, note: 'WAITING: confirmation dialog not answered within 15 s' + (autoApprove ? ' although autoApprove is on' : ' (expected when nobody is at the screen)') });
	}
	if (has('list_browser_pages') && dialogTools.includes('open_browser_page')) {
		results.push({ name: 'page tools', ok: true, note: 'SKIPPED: no page, because the open_browser_page dialog was not answered' });
	}
} finally {
	await client?.close().catch(() => undefined);
	page.close();
	clicker?.kill();
	if (clickerErrors) {
		console.log(`\nwindow-helper.ps1 errors:\n${clickerErrors}`);
	}
	if (existsSync(dialogLog)) {
		console.log(`\nwindow-helper.ps1 log:\n${readFileSync(dialogLog, 'utf8')}`);
	}
	if (code.pid) {
		spawnSync('taskkill', ['/pid', String(code.pid), '/T', '/F'], { stdio: 'ignore' });
	}
}

console.log('\n=== Results ===');
for (const r of results) {
	console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.note ? `  -- ${r.note}` : ''}`);
}
process.exit(results.every(r => r.ok) ? 0 : 1);
