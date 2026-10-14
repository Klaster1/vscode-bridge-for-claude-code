// End-to-end check in an isolated VS Code: downloads VS Code 1.138.0 into
// .vscode-test/, starts it with its own user-data and extensions folders and
// this extension loaded from source, then talks to the bridge through
// launcher.ts exactly as Claude Code would (stdio MCP, cwd = workspace root).
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
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from '@vscode/test-electron';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { discoveryFile, type DiscoveryRecord } from '../src/discovery.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const run = join(root, '.vscode-test', 'run');
const workspace = join(run, 'workspace');
const discovery = join(run, 'discovery');
process.env['VSCODE_TOOLS_BRIDGE_DIR'] = discovery;

rmSync(run, { recursive: true, force: true });
mkdirSync(join(run, 'user-data', 'User'), { recursive: true });
mkdirSync(join(run, 'extensions'), { recursive: true });
cpSync(join(root, 'test', 'fixture'), workspace, { recursive: true });
const autoApprove = !!process.env['BRIDGE_TEST_AUTO_APPROVE'];
const settingsFile = join(run, 'user-data', 'User', 'settings.json');
const writeSettings = (enabled: boolean) => writeFileSync(settingsFile, JSON.stringify({
	'security.workspace.trust.enabled': false,
	'update.mode': 'none',
	'telemetry.telemetryLevel': 'off',
	'workbench.startupEditor': 'none',
	'workbench.editor.closeEmptyGroups': false, // The bridge's startup panel must leave no empty group behind.
	'workbench.editorAssociations': { '*.md': 'vscode.markdown.editor' },
	'chat.agent.enabled': true,
	'workbench.browser.enableChatTools': true,
	'vscodeToolsBridge.executeCommand.deny': ['workbench.action.quit'],
	'vscodeToolsBridge.enabled': enabled,
	'vscodeToolsBridge.autoApprove': autoApprove,
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
const runHook = (cwd: string) => {
	const started = Date.now();
	const out = spawnSync(process.execPath, [join(root, 'prompt-hook.ts')], {
		input: JSON.stringify({ session_id: 'test', transcript_path: '', cwd, permission_mode: 'default', hook_event_name: 'UserPromptSubmit', prompt: 'What is on the page?' }),
		env, encoding: 'utf8', timeout: 5000,
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
			e.isDirectory() ? walk(join(dir, e.name)) : e.name === 'VS Code Tools Bridge.log' ? readFileSync(join(dir, e.name), 'utf8') : '').join('');
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
	await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'launcher.ts')], cwd: workspace, env: env as Record<string, string>, stderr: 'inherit' }));
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
	await check('the bridge starts with the layout it found', async () => {
		const groups = textOf(await call('execute_command', { command: 'standin.groupCount' }));
		return groups === '1' || `${groups} editor groups`;
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
			all.includes(`notes.md (active), lines 1-${lines}, selected text:\n\`\`\`\n${notes}\n\`\`\``) || all.slice(0, 300));
		const h = runHook(workspace);
		const context = hookContext(h.stdout) ?? '';
		results.push({ name: 'prompt hook reports the selection', ok: h.status === 0 && context.includes(`lines 1-${lines}, selected text:`) && context.includes('Second paragraph.') && /Markdown Editor/.test(context), note: `${h.ms} ms` });
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
		await check('markdown_editor_selection marks the delivered selection', async () => /lines 1-\d+, shown in Claude Code's selection chip, selected text:/.test(delivered) || delivered.slice(0, 300));
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
