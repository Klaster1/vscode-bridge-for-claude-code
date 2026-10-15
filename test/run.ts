// End-to-end check in an isolated VS Code, on Windows only: it needs test/window-helper.ps1,
// which drives the windows through Win32 and UI Automation. Downloads VS Code 1.140.0 into
// .vscode-test/, starts it with its own user-data and extensions folders,
// this extension loaded from source and SemanticDiff 0.10.0 from the marketplace
// (cached in .vscode-test/), then talks to the bridge through the Claude Code
// plugin's launcher and prompt hook, with the command lines its manifests give Claude Code
// (stdio MCP, cwd = workspace root). The user's own VS Code and Claude Code config are never touched.
//
//   node test/run.ts            (Node 22.18+), extension loaded from source
//   BRIDGE_TEST_VSIX=path\to.vsix node test/run.ts   installs that VSIX into the
//                                isolated extensions folder and tests it instead
//   BRIDGE_TEST_AUTO_APPROVE=1   turns on vscodeBridge.autoApprove and the
//                                proposed API it needs; with BRIDGE_TEST_NO_CLICK=1
//                                the browser tools must then run with no dialog
//   BRIDGE_TEST_NO_CLICK=1       leaves the confirmation dialogs for a person
//   BRIDGE_TEST_WINDOW=none      leaves the test window where VS Code puts it; the
//                                default, offscreen, moves it away without activating it
//   BRIDGE_TEST_TRACE=1          starts VS Code with --log=trace

import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect, createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from '@vscode/test-electron';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import { discoveryFile, type DiscoveryRecord } from '../plugin/scripts/discovery.ts';
import { commandLine } from '../src/shell.ts';
import { keepUrlHandler } from './url-handler.ts';

if (process.platform !== 'win32') {
	console.error('test/run.ts runs on Windows only. It starts VS Code windows and answers their dialogs with test/window-helper.ps1, which uses Win32 and UI Automation. CI runs it on Windows.');
	process.exit(1);
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const run = join(root, '.vscode-test', 'run');
const workspace = join(run, 'workspace');
const discovery = join(run, 'discovery');
process.env['VSCODE_BRIDGE_DIR'] = discovery;

rmSync(run, { recursive: true, force: true });
mkdirSync(join(run, 'user-data', 'User'), { recursive: true });
mkdirSync(join(run, 'extensions'), { recursive: true });
cpSync(join(root, 'test', 'fixture'), workspace, { recursive: true });
// A workspace that empties the user's deny list, as a cloned repo's .vscode/settings.json could. The deny list is in the user settings below.
mkdirSync(join(workspace, '.vscode'));
writeFileSync(join(workspace, '.vscode', 'settings.json'), JSON.stringify({ 'vscodeBridge.executeCommand.deny': [] }));
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
	'extensions.confirmedUriHandlerExtensionIds': ['klaster1.vscode-bridge-for-claude-code'], // Skips the prompt that a link to an extension raises.
	'workbench.editorAssociations': { '*.md': 'vscode.markdown.editor' },
	'chat.agent.enabled': true,
	'workbench.browser.enableChatTools': true,
	'vscodeBridge.executeCommand.deny': ['workbench.action.quit'],
	'vscodeBridge.enabled': enabled,
	'vscodeBridge.autoApprove': autoApprove,
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

const exe = await downloadAndUnzipVSCode({ version: '1.140.0', cachePath: join(root, '.vscode-test') });
keepUrlHandler();
// SemanticDiff, for the checks of its diff panel's selection. Node's fetch decodes the marketplace's gzip-encoded response.
const semanticDiffVsix = join(root, '.vscode-test', 'semanticdiff-0.10.0-win32-x64.vsix');
if (!existsSync(semanticDiffVsix)) {
	const response = await fetch('https://marketplace.visualstudio.com/_apis/public/gallery/publishers/semanticdiff/vsextensions/semanticdiff/0.10.0/vspackage?targetPlatform=win32-x64');
	const data = Buffer.from(await response.arrayBuffer());
	if (!response.ok || data.subarray(0, 2).toString() !== 'PK') {
		throw new Error(`Downloading SemanticDiff failed: HTTP ${response.status}, ${data.length} bytes`);
	}
	writeFileSync(semanticDiffVsix, data);
}
// The port the test drives the window's pages through, with the Chrome DevTools Protocol.
const cdpPort = await new Promise<number>(resolve => {
	const probe = createNetServer().listen(0, '127.0.0.1', () => {
		const { port } = probe.address() as AddressInfo;
		probe.close(() => resolve(port));
	});
});
// Drop variables inherited from a VS Code or Claude Code parent so the test
// instance cannot mistake itself for a CLI call into the user's running VS Code.
const env: NodeJS.ProcessEnv = {};
for (const [k, v] of Object.entries(process.env)) {
	if (!/^(VSCODE_|ELECTRON_)/.test(k) || k === 'VSCODE_BRIDGE_DIR') {
		env[k] = v;
	}
}
// The plugin's MCP server and prompt hook, as Claude Code starts them from the plugin's manifests.
type PluginCommand = { command: string; args: string[] };
const pluginRoot = join(root, 'plugin');
const pluginJson = <T>(path: string): T => JSON.parse(readFileSync(join(pluginRoot, path), 'utf8')) as T;
const inPlugin = ({ command, args }: PluginCommand): PluginCommand => ({ command, args: args.map(a => a.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot)) });
const launcher = inPlugin(pluginJson<{ mcpServers: Record<string, PluginCommand> }>('.claude-plugin/plugin.json').mcpServers['vscode-tools']!);
const hook = inPlugin(pluginJson<{ hooks: Record<string, { hooks: PluginCommand[] }[]> }>('hooks/hooks.json').hooks['UserPromptSubmit']![0]!.hooks[0]!);
env['CLAUDE_PLUGIN_ROOT'] = pluginRoot;
const vsix = process.env['BRIDGE_TEST_VSIX'];
{
	// Keep the CLI script path but replace its default user-data and extensions folders with ours.
	const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(exe).filter(a => !/^--(user-data|extensions)-dir=/.test(a));
	const installs = [semanticDiffVsix, ...(vsix ? [vsix] : [])].flatMap(file => ['--install-extension', file]);
	const installed = spawnSync(commandLine(cli!, [...cliArgs, `--user-data-dir=${join(run, 'user-data')}`, `--extensions-dir=${join(run, 'extensions')}`, ...installs]), { env, encoding: 'utf8', shell: true });
	console.log(installed.stdout, installed.stderr);
}
const code = spawn(exe, [
	workspace,
	join(workspace, 'src', 'greet.ts'), // An open editor, as after a reload: a panel opened beside it would add a group.
	...(vsix ? [] : [`--extensionDevelopmentPath=${root}`]),
	`--extensionDevelopmentPath=${join(root, 'test', 'standin')}`, // Plays Claude Code's chat webview.
	`--extensionDevelopmentPath=${join(root, 'test', 'diffhost')}`, // Shows SemanticDiff's page in an editor tab of its own.
	`--user-data-dir=${join(run, 'user-data')}`,
	`--extensions-dir=${join(run, 'extensions')}`,
	'--disable-workspace-trust',
	'--skip-welcome',
	'--skip-release-notes',
	'--new-window',
	`--remote-debugging-port=${cdpPort}`,
	...(autoApprove ? ['--enable-proposed-api=klaster1.vscode-bridge-for-claude-code'] : []),
	...(process.env['BRIDGE_TEST_TRACE'] ? ['--log=trace'] : []),
], { env, stdio: 'ignore' });

// test/window-helper.ps1 keeps the test window out of the user's way and
// answers the confirmation dialogs that tokenless tool calls raise, touching
// only windows of this instance's main process. BRIDGE_TEST_WINDOW picks how
// the window is kept away: offscreen (default; stays rendered, which
// Playwright's click needs) or none.
// BRIDGE_TEST_NO_CLICK=1 leaves dialogs for a person (or the 15 s timeout).
const dialogLog = join(run, 'window-helper.log');
const clicker = process.platform === 'win32' && code.pid
	? spawn('powershell.exe', [
		'-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'test', 'window-helper.ps1'),
		'-ProcessId', String(code.pid), '-LogFile', dialogLog,
		'-Hide', process.env['BRIDGE_TEST_WINDOW'] ?? 'offscreen',
		'-Size', '1024x768', // The CI runner's screen size, so a local run lays the window out as CI does.
		...(process.env['BRIDGE_TEST_NO_CLICK'] ? ['-NoClick'] : []),
	], { stdio: ['ignore', 'ignore', 'pipe'] })
	: undefined;
let clickerErrors = '';
clicker?.stderr?.on('data', d => { clickerErrors += String(d); });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const results: { name: string; ok: boolean; note: string }[] = [];
let client: Client | undefined;
let cdp: Browser | undefined;

// Runs the plugin's prompt hook the way Claude Code runs a UserPromptSubmit hook: a
// fresh process, the hook payload as JSON on stdin, cwd in the payload.
const runHook = (cwd: string, surface: 'chip' | 'cli' | 'cli-without-vscode' = 'chip') => {
	const started = Date.now();
	const out = spawnSync(hook.command, hook.args, {
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
		await sleep(500);
	}
	{
		const h = runHook(workspace);
		results.push({ name: 'prompt hook, bridge off', ok: h.status === 0 && h.stdout === '', note: `exit ${h.status}, ${h.stdout.length} bytes, ${h.ms} ms` });
	}
	results.push({ name: 'off while disabled', ok: /enabled is off/.test(bridgeLog()) && !existsSync(file), note: existsSync(file) ? 'discovery file exists while disabled' : 'logged "enabled is off", no discovery file' });
	writeSettings(true);
	for (let i = 0; i < 180 && !existsSync(file); i++) {
		await sleep(500);
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
	await client.connect(new StdioClientTransport({ command: launcher.command, args: launcher.args, cwd: workspace, env: env as Record<string, string>, stderr: 'inherit' }));
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
	const cliDiffSelections = async () => (JSON.parse(textOf(await call('execute_command', { command: 'standin.selections' }))) as { uri: string; text: string }[]).filter(s => /[\\/]diff[\\/]/.test(s.uri));
	type ChipPayload = { filePath: string; startLine: number; endLine: number; startColumn?: number; endColumn?: number; selectedText?: string };
	const chipSelections = async (): Promise<(ChipPayload | undefined)[]> =>
		(JSON.parse(textOf(await call('execute_command', { command: 'standin.received' }))) as { message?: { request?: { type?: string; selection?: ChipPayload } } }[])
			.flatMap(m => m.message?.request?.type === 'selection_changed' ? [m.message.request.selection] : []);
	const lf = (t: string | undefined) => t?.replaceAll('\r\n', '\n');

	// SemanticDiff's diff panel draws its own selection, so the checks select with the mouse, through the Chrome DevTools Protocol.
	const diffLines = (side: 'before' | 'after') => readFileSync(join(workspace, 'diff', `${side}.ts`), 'utf8').split(/\r?\n/);
	const diffText = (side: 'before' | 'after', from: number, to: number) => diffLines(side).slice(from - 1, to).join('\n');
	const semanticDiffFrame = async (): Promise<{ page: Page; frame: Frame }> => {
		cdp ??= await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
		for (const end = Date.now() + 30_000; Date.now() < end; await sleep(500)) {
			for (const page of cdp.contexts().flatMap(c => c.pages())) {
				for (const frame of page.frames()) {
					if (await frame.locator('#new-path').count().catch(() => 0) && await frame.locator('.code-fg').count().catch(() => 0)) {
						return { page, frame };
					}
				}
			}
		}
		throw new Error('no SemanticDiff panel with code lines');
	};
	/**
	 * A point on a code line of the panel, in the workbench page's coordinates: before its first
	 * character, after its last one, or in the middle of a word. A long line wraps in a narrow
	 * panel, so each point is on the screen row of the character it is next to. SemanticDiff
	 * renders only the rows near the screen, so a point out of view is scrolled to: its line to
	 * the top of the view for `scroll: 'top'`, the point to the middle otherwise. With
	 * `scroll: 'none'` the point must be in view already.
	 */
	const linePoint = async (line: string, at: string, scroll: 'top' | 'center' | 'none' = 'center') => {
		const find = `(() => {
			const norm = t => t.replace(/\\s+/g, ' ').trim();
			const lines = [...document.querySelectorAll('.code-fg')];
			const index = lines.findIndex(el => norm(el.textContent) === norm(${JSON.stringify(line)}));
			const header = document.getElementById('stickyHeader')?.getBoundingClientRect().bottom ?? 0;
			const scroll = ${JSON.stringify(scroll)};
			if (index < 0) {
				// Not rendered: look further down, and from the top again at the end.
				if (scroll === 'none') { return null; }
				const atEnd = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 1;
				atEnd ? window.scrollTo(0, 0) : window.scrollBy(0, window.innerHeight / 2);
				return null;
			}
			const box = lines[index].getBoundingClientRect();
			if (scroll === 'top' && Math.abs(box.top - header - 8) > 2) {
				const before = window.scrollY;
				window.scrollBy(0, box.top - header - 8); // Below the sticky header, which covers the lines under it.
				if (window.scrollY !== before) { return null; } // Else the page ends before the line reaches the top.
			}
			const nodes = [];
			const walker = document.createTreeWalker(lines[index], NodeFilter.SHOW_TEXT);
			for (let node; (node = walker.nextNode());) { if (node.data.length) { nodes.push(node); } }
			const rect = (node, from, to) => { const r = document.createRange(); r.setStart(node, from); r.setEnd(node, to); const b = r.getBoundingClientRect(); return { left: b.left - box.left, right: b.right - box.left, y: b.top - box.top + b.height / 2 }; };
			const at = ${JSON.stringify(at)};
			let point = null;
			if (at === 'start') { const r = rect(nodes[0], 0, 1); point = { index, x: 1, y: r.y }; }
			else if (at === 'end') { const last = nodes[nodes.length - 1]; const r = rect(last, last.data.length - 1, last.data.length); point = { index, x: Math.min(r.right + 3, box.width - 2), y: r.y }; }
			else {
				// A narrow panel breaks a word over two screen rows, and so over two text nodes: aim at its first character.
				let i = nodes.map(n => n.data).join('').indexOf(at);
				for (const node of nodes) {
					if (i >= 0 && i < node.data.length) { const r = rect(node, i, i + 1); point = { index, x: (r.left + r.right) / 2, y: r.y }; break; }
					i -= node.data.length;
				}
			}
			// A wrapped line can be taller than the view, so only the point itself must be in view.
			const y = point && box.top + point.y;
			if (point && (y < header + 4 || y > window.innerHeight - 4)) {
				if (scroll === 'center') { window.scrollBy(0, y - (header + window.innerHeight) / 2); }
				return null;
			}
			return point;
		})()`;
		for (const end = Date.now() + 15_000; ; await sleep(250)) {
			const { page, frame } = await semanticDiffFrame();
			const found = await frame.evaluate(find).catch(() => null) as { index: number; x: number; y: number } | null;
			const box = found && await frame.locator('.code-fg').nth(found.index).boundingBox().catch(() => null);
			if (found && box) {
				return { page, x: box.x + found.x, y: box.y + found.y };
			}
			if (Date.now() > end) {
				const shown = await (await semanticDiffFrame()).frame.evaluate(`[...document.querySelectorAll('.code-fg')].map(el => { const r = el.getBoundingClientRect(); return [...el.querySelectorAll('span')].map(n => n.textContent).join('|') + ' @' + Math.round(r.top) + '-' + Math.round(r.bottom) + ' of ' + window.innerHeight; })`).catch(() => []);
				throw new Error(`no line "${line}" with "${at}" in view in the SemanticDiff panel; it shows ${JSON.stringify(shown)}`);
			}
		}
	};
	// The first line goes to the top of the view, so that the drag needs no scrolling.
	const dragLines = async (from: string, to: string) => {
		await linePoint(from, 'start', 'top');
		const a = await linePoint(from, 'start', 'none');
		const b = await linePoint(to, 'end', 'none');
		await a.page.mouse.move(a.x, a.y);
		await a.page.mouse.down();
		await a.page.mouse.move(b.x, b.y, { steps: 5 });
		await a.page.mouse.up();
	};
	const openSemanticDiff = async () => {
		await call('execute_command', { command: 'vscode.diff', args: [{ $uri: 'diff/before.ts' }, { $uri: 'diff/after.ts' }, 'before.ts vs after.ts'] });
		await sleep(2000);
		await call('execute_command', { command: 'semanticdiff.show' });
		await linePoint(diffLines('after')[0]!, 'start');
	};
	// SemanticDiff's page in an editor tab of another extension, test/diffhost, in front of the text diff it shows.
	const openHostedDiff = async (early: boolean) => {
		await call('execute_command', { command: 'vscode.diff', args: [{ $uri: 'diff/before.ts' }, { $uri: 'diff/after.ts' }, 'before.ts vs after.ts'] });
		await sleep(2000);
		await call('execute_command', { command: 'diffhost.prepare', args: [early] });
		await call('execute_command', { command: 'semanticdiff.show', args: [{ $uri: 'diff/after.ts' }] });
		await linePoint(diffLines('after')[0]!, 'start');
	};
	// The SemanticDiff panel, then the diff it replaced. Both are in the first group, which a check may have left inactive.
	const closeSemanticDiff = async () => {
		await call('execute_command', { command: 'workbench.action.focusFirstEditorGroup' });
		await call('execute_command', { command: 'workbench.action.closeActiveEditor' });
		await call('execute_command', { command: 'workbench.action.closeActiveEditor' });
	};
	/** The chip posts once there are more than `count` and the last one passes `done`. */
	const chipSelectionsAfter = async (count: number, done: (last: ChipPayload | undefined) => boolean = () => true) => {
		let posts = await chipSelections();
		for (const end = Date.now() + 20_000; !(posts.length > count && done(posts.at(-1))) && Date.now() < end; posts = await chipSelections()) {
			await sleep(500);
		}
		return posts;
	};
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
	// Each of these types keeps its data in private fields or getters, so the JSON of an unhandled one is {}.
	await expectText('execute_command returns the text of a hover', 'execute_command', { command: 'vscode.executeHoverProvider', args: [{ $uri: 'src/use.ts' }, { $position: { line: 2, character: 14 } }] }, /const message: string/);
	await expectText('execute_command returns the edits of a rename', 'execute_command', { command: 'vscode.executeDocumentRenameProvider', args: [{ $uri: 'src/greet.ts' }, { $position: { line: 0, character: 18 } }, 'renamedAgain'] }, /"newText": "renamedAgain"/);
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
		await sleep(2000);
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
				await sleep(500);
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
			for (const end = Date.now() + 20_000; Date.now() < end; await sleep(500)) {
				posts = (await standinMessages()).filter(m => m.request?.type === 'selection_changed');
				if (done(posts.length)) {
					break;
				}
			}
			return posts;
		};
		await check('stand-in webview is live', async () => {
			for (const end = Date.now() + 20_000; Date.now() < end; await sleep(500)) {
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
		await expectText('semantic_diff_selection, no SemanticDiff panel in front', 'semantic_diff_selection', {}, /No SemanticDiff panel is in front/);
		// The side bars leave SemanticDiff's code columns a few characters wide in a 1024×768 window.
		await call('execute_command', { command: 'workbench.action.closeSidebar' });
		await call('execute_command', { command: 'workbench.action.closeAuxiliaryBar' });
		const diffSelectionNow = async () => textOf(await call('semantic_diff_selection', {}));
		const until = async (done: (t: string) => boolean, ms = 20_000): Promise<string> => {
			let t = await diffSelectionNow();
			for (const end = Date.now() + ms; !done(t) && Date.now() < end; t = await diffSelectionNow()) {
				await sleep(500);
			}
			return t;
		};
		await check('SemanticDiff opens its diff panel', async () => {
			await openSemanticDiff();
			return true;
		});
		await call('execute_command', { command: 'standin.open' }); // Its first post lets the bridge find it.
		await sleep(3000);
		const after = diffLines('after');
		const before = diffLines('before');

		// A drag over three lines of the modified side.
		let count = (await chipSelections()).length;
		await dragLines(after[3]!, after[5]!);
		const modified = diffText('after', 4, 6);
		const modifiedChip = (await chipSelectionsAfter(count, last => !!last?.selectedText)).at(-1);
		await check('SemanticDiff: Claude Code webview receives a modified-side selection', async () =>
			/[\\/]diff[\\/]after\.ts$/.test(modifiedChip?.filePath ?? '') && modifiedChip?.startLine === 4 && modifiedChip.endLine === 6
			&& modifiedChip.startColumn === 0 && modifiedChip.endColumn === after[5]!.length && lf(modifiedChip.selectedText) === modified || JSON.stringify(modifiedChip).slice(0, 300));
		await check('SemanticDiff: Claude Code CLI listener receives the modified-side selection', async () => {
			const got = await cliDiffSelections();
			return got.some(s => s.uri.endsWith('after.ts') && lf(s.text) === modified) || JSON.stringify(got).slice(0, 300);
		});
		const modifiedTool = await until(t => t.includes('shown in Claude Code'));
		console.log(`\n--- semantic_diff_selection after a drag on the modified side ---\n${modifiedTool}`);
		await check('semantic_diff_selection returns the modified-side lines and text', async () =>
			/after\.ts \(active\), compared with \S*before\.ts, modified side, lines 4-6, shown in Claude Code's selection chip[^\n]*selected text:/.test(modifiedTool)
			&& lf(modifiedTool)!.includes(`\n${modified}\n`) || modifiedTool.slice(0, 400));
		{
			const unconnected = hookContext(runHook(workspace, 'cli-without-vscode').stdout) ?? '';
			results.push({ name: 'prompt hook reports a SemanticDiff selection', ok: /SemanticDiff/.test(unconnected) && unconnected.includes('modified side, lines 4-6') && unconnected.includes('sum += price * (1 - discount);'), note: unconnected.slice(0, 200) });
			const chip = hookContext(runHook(workspace).stdout) ?? '';
			results.push({ name: 'prompt hook skips a SemanticDiff selection the chip shows', ok: !chip.includes('SemanticDiff'), note: chip.slice(0, 200) });
		}

		// A drag over three lines of the original side.
		count = (await chipSelections()).length;
		await dragLines(before[3]!, before[5]!);
		const original = diffText('before', 4, 6);
		const originalChip = (await chipSelectionsAfter(count, last => /before\.ts$/.test(last?.filePath ?? '') && !!last?.selectedText)).at(-1);
		await check('SemanticDiff: Claude Code webview receives an original-side selection with the original\'s lines', async () =>
			/[\\/]diff[\\/]before\.ts$/.test(originalChip?.filePath ?? '') && originalChip?.startLine === 4 && originalChip.endLine === 6 && lf(originalChip.selectedText) === original || JSON.stringify(originalChip).slice(0, 300));
		await check('SemanticDiff: Claude Code CLI listener receives the original-side selection', async () => {
			const got = await cliDiffSelections();
			return got.some(s => s.uri.endsWith('before.ts') && lf(s.text) === original) || JSON.stringify(got).slice(0, 300);
		});
		const originalTool = await until(t => t.includes('original side'));
		console.log(`\n--- semantic_diff_selection after a drag on the original side ---\n${originalTool}`);
		await check('semantic_diff_selection names the original side and its lines', async () =>
			/original side, lines 4-6 of the original version, shown in Claude Code's selection chip[^\n]*selected text:/.test(originalTool) && lf(originalTool)!.includes(`\n${original}\n`) || originalTool.slice(0, 400));
		{
			const unconnected = hookContext(runHook(workspace, 'cli-without-vscode').stdout) ?? '';
			results.push({ name: 'prompt hook names the original version of a SemanticDiff selection', ok: unconnected.includes('original side, lines 4-6 of the original version') && unconnected.includes('original version the entry names') && unconnected.includes('sum += price;'), note: unconnected.slice(0, 200) });
		}

		// A double-click selects a word.
		count = (await chipSelections()).length;
		{
			const word = await linePoint(after[0]!, 'discount');
			await word.page.mouse.dblclick(word.x, word.y);
		}
		const wordPosts = await chipSelectionsAfter(count, last => last?.selectedText === 'discount'); // The double-click's first click sends a cursor before the word.
		await check('SemanticDiff: a double-click sends the word', async () => {
			const w = wordPosts.at(-1);
			return w?.selectedText === 'discount' && w.startLine === 1 && w.endLine === 1 && /after\.ts$/.test(w.filePath) || JSON.stringify(w).slice(0, 300);
		});

		// A click leaves a cursor.
		count = wordPosts.length;
		{
			const at = await linePoint(after[8]!, 'currency');
			await at.page.mouse.click(at.x, at.y);
		}
		const cursorPosts = await chipSelectionsAfter(count, last => last?.selectedText === undefined);
		await check('SemanticDiff: a click reaches Claude Code as a cursor line', async () => {
			const c = cursorPosts.at(-1);
			return c?.startLine === 9 && c.endLine === 9 && c.selectedText === undefined && /after\.ts$/.test(c.filePath) || JSON.stringify(c).slice(0, 300);
		});
		const cursorTool = await until(t => t.includes('cursor on line'));
		await check('semantic_diff_selection reports the cursor line when nothing is selected', async () =>
			/after\.ts \(active\), compared with \S*before\.ts: nothing selected, cursor on line 9 of the modified version\./.test(cursorTool) || cursorTool.slice(0, 300));
		{
			const quiet = hookContext(runHook(workspace, 'cli-without-vscode').stdout) ?? '';
			results.push({ name: 'prompt hook adds nothing for a SemanticDiff cursor', ok: !quiet.includes('SemanticDiff'), note: quiet.slice(0, 200) });
		}

		// Focus the stand-in's group and come back: Claude Code may have cleared its chip meanwhile.
		{
			const word = await linePoint(after[0]!, 'discount');
			await word.page.mouse.dblclick(word.x, word.y);
		}
		const beforeRefocus = (await chipSelectionsAfter(cursorPosts.length, last => last?.selectedText === 'discount')).length;
		await call('execute_command', { command: 'workbench.action.focusSecondEditorGroup' });
		await call('execute_command', { command: 'workbench.action.focusFirstEditorGroup' });
		const refocused = await chipSelectionsAfter(beforeRefocus);
		await check('a SemanticDiff panel coming to the front sends its selection again', async () =>
			refocused.length > beforeRefocus && refocused.at(-1)?.selectedText === 'discount' || `${beforeRefocus} -> ${refocused.length} posts`);
		await call('execute_command', { command: 'standin.close' });
		await closeSemanticDiff();
		await expectText('semantic_diff_selection, panel closed', 'semantic_diff_selection', {}, /No SemanticDiff panel is in front/);
	}

	{
		// SemanticDiff's page in another extension's editor tab, not SemanticDiff's own panel.
		const diffSelectionNow = async () => textOf(await call('semantic_diff_selection', {}));
		const until = async (done: (t: string) => boolean, ms = 20_000): Promise<string> => {
			let t = await diffSelectionNow();
			for (const end = Date.now() + ms; !done(t) && Date.now() < end; t = await diffSelectionNow()) {
				await sleep(500);
			}
			return t;
		};
		await call('execute_command', { command: 'standin.open' });
		await sleep(3000);
		await check('another extension\'s tab shows SemanticDiff\'s page', async () => {
			await openHostedDiff(false);
			return true;
		});
		const after = diffLines('after');
		const listed = await until(t => t.includes('nothing selected'));
		await check('semantic_diff_selection lists SemanticDiff\'s page in another extension\'s tab', async () =>
			/after\.ts \(active\), compared with \S*before\.ts: nothing selected\./.test(listed) || listed.slice(0, 300));
		const count = (await chipSelections()).length;
		const cliCount = (await cliDiffSelections()).length;
		await dragLines(after[3]!, after[5]!);
		const modified = diffText('after', 4, 6);
		const hostedChip = (await chipSelectionsAfter(count, last => !!last?.selectedText)).at(-1);
		await check('SemanticDiff in another extension\'s tab: Claude Code webview receives the selection', async () =>
			/after\.ts$/.test(hostedChip?.filePath ?? '') && hostedChip?.startLine === 4 && hostedChip.endLine === 6 && lf(hostedChip.selectedText) === modified || JSON.stringify(hostedChip).slice(0, 300));
		await check('SemanticDiff in another extension\'s tab: Claude Code CLI listener receives the selection', async () => {
			const got = (await cliDiffSelections()).slice(cliCount);
			return got.some(s => s.uri.endsWith('after.ts') && lf(s.text) === modified) || JSON.stringify(got).slice(0, 300);
		});
		{
			const note = hookContext(runHook(workspace, 'cli-without-vscode').stdout) ?? '';
			results.push({ name: 'prompt hook reports a selection in another extension\'s tab', ok: note.includes('modified side, lines 4-6') && note.includes('sum += price * (1 - discount);'), note: note.slice(0, 200) });
		}
		const beforeRefocus = (await chipSelections()).length;
		await call('execute_command', { command: 'workbench.action.focusSecondEditorGroup' });
		await call('execute_command', { command: 'workbench.action.focusFirstEditorGroup' });
		const refocused = await chipSelectionsAfter(beforeRefocus);
		await check('SemanticDiff\'s page in another extension\'s tab sends its selection again when it is active again', async () =>
			refocused.length > beforeRefocus && lf(refocused.at(-1)?.selectedText) === modified || `${beforeRefocus} -> ${refocused.length} posts`);
		// Another tab in front of it: VS Code drops the page, which comes back with no selection.
		await call('execute_command', { command: 'workbench.action.nextEditorInGroup' });
		const behind = await until(t => t.includes('No SemanticDiff panel is in front'));
		await call('execute_command', { command: 'workbench.action.previousEditorInGroup' });
		const back = await until(t => t.includes('nothing selected'));
		await check('SemanticDiff\'s page behind another tab is not listed, and comes back with no selection', async () =>
			/No SemanticDiff panel is in front/.test(behind) && /after\.ts \(active\), compared with \S*before\.ts: nothing selected\./.test(back) || `${behind.slice(0, 150)} | ${back.slice(0, 150)}`);
		await call('execute_command', { command: 'standin.close' });
		await closeSemanticDiff();
		await expectText('semantic_diff_selection, the other extension\'s tab closed', 'semantic_diff_selection', {}, /No SemanticDiff panel is in front/);
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
				await sleep(1500);
				const t = await tab();
				await call('execute_command', { command: 'workbench.action.closeActiveEditor' });
				return via === route && t.kind === kind && (t.viewType ?? undefined) === viewType && t.uri?.endsWith(file.replace('/', '\\')) || `via ${via}, tab ${JSON.stringify(t)}`;
			});
		}
		await check('showTextDocument with a TextDocument is not rejected', async () => {
			const result = textOf(await call('execute_command', { command: 'standin.showDocument', args: [{ $uri: 'notes.md' }] })).replace(/^"|"$/g, '');
			await sleep(1500);
			const t = await tab();
			await call('execute_command', { command: 'workbench.action.closeActiveEditor' });
			return result === 'shown' && t.kind === 'text' || `${result}, tab ${JSON.stringify(t)}`;
		});

		// Each patch has its own setting, which takes effect without a reload.
		const setSetting = async (key: string, value: boolean) => {
			overrides[`vscodeBridge.${key}`] = value;
			writeSettings(true);
			for (const end = Date.now() + 30_000; Date.now() < end; await sleep(500)) {
				if (textOf(await call('execute_command', { command: 'standin.setting', args: [key] })) === String(value)) {
					break;
				}
			}
			await sleep(1000);
		};
		const followLink = async (file: string) => {
			const via = await openLink(file);
			await sleep(1500);
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
			await sleep(3000);
			await call('execute_command', { command: 'markdown.editor.selectAll' });
			await sleep(3000);
		};
		await setSetting('markdownEditor.selection', false);
		await call('execute_command', { command: 'standin.open' });
		await sleep(3000);
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
		{
			// The same setting covers SemanticDiff's panel.
			const postsBeforeDiff = await postsToClaude();
			const cliBeforeDiff = (await cliDiffSelections()).length;
			await openSemanticDiff();
			await dragLines(diffLines('after')[3]!, diffLines('after')[5]!);
			await sleep(3000);
			await check('SemanticDiff selection off: the tool reads nothing', async () => {
				const t = textOf(await call('semantic_diff_selection', {}));
				return /not being read/.test(t) || t.slice(0, 300);
			});
			await check('SemanticDiff selection off: nothing reaches Claude Code', async () => {
				const after = await postsToClaude();
				const cliAfter = (await cliDiffSelections()).length;
				return after === postsBeforeDiff && cliAfter === cliBeforeDiff || `${postsBeforeDiff} -> ${after} chip posts, ${cliBeforeDiff} -> ${cliAfter} CLI selections`;
			});
			const h = runHook(workspace, 'cli-without-vscode');
			results.push({ name: 'SemanticDiff selection off: the prompt hook adds nothing', ok: h.status === 0 && !(hookContext(h.stdout) ?? '').includes('SemanticDiff'), note: `${h.ms} ms` });
			await closeSemanticDiff();
		}
		await call('execute_command', { command: 'workbench.action.closeActiveEditor' });
		await call('execute_command', { command: 'standin.close' });
		await setSetting('markdownEditor.selection', true);
		await call('execute_command', { command: 'standin.open' }); // Its first post lets the bridge find it again.
		await sleep(3000);
		await selectAllInMarkdownEditor();
		await check('Markdown Editor selection on again: the tool and Claude Code get the selection', async () => {
			const t = textOf(await call('markdown_editor_selection', {}));
			const after = await postsToClaude();
			return /lines 1-\d+, shown in Claude Code's selection chip[^\n]*selected text:/.test(t) && after > postsBefore || `${t.slice(0, 200)}; ${postsBefore} -> ${after} posts`;
		});
		await call('execute_command', { command: 'workbench.action.closeActiveEditor' });
		{
			const postsBeforeDiff = await postsToClaude();
			await openSemanticDiff();
			await dragLines(diffLines('after')[3]!, diffLines('after')[5]!);
			const t = await (async () => {
				let text = '';
				for (const end = Date.now() + 20_000; Date.now() < end && !text.includes('shown in Claude Code'); await sleep(500)) {
					text = textOf(await call('semantic_diff_selection', {}));
				}
				return text;
			})();
			await check('SemanticDiff selection on again: the tool and Claude Code get the selection', async () => {
				const after = await postsToClaude();
				return /modified side, lines 4-6, shown in Claude Code's selection chip[^\n]*selected text:/.test(t) && after > postsBeforeDiff || `${t.slice(0, 200)}; ${postsBeforeDiff} -> ${after} posts`;
			});
			await closeSemanticDiff();
		}
		{
			// An extension that took the webview's html setter while the patch was off sets SemanticDiff's page past the patch, as one that starts before the bridge does.
			await setSetting('markdownEditor.selection', false);
			await call('execute_command', { command: 'vscode.diff', args: [{ $uri: 'diff/before.ts' }, { $uri: 'diff/after.ts' }, 'before.ts vs after.ts'] });
			await sleep(2000);
			await call('execute_command', { command: 'diffhost.prepare', args: [true] });
			await setSetting('markdownEditor.selection', true);
			await call('execute_command', { command: 'standin.close' });
			await call('execute_command', { command: 'standin.open' }); // Its first post lets the bridge find it again.
			await sleep(3000);
			await call('execute_command', { command: 'semanticdiff.show', args: [{ $uri: 'diff/after.ts' }] });
			await linePoint(diffLines('after')[0]!, 'start');
			await sleep(2000); // The bridge sets the page again, and it reloads.
			const postsBeforeLate = await postsToClaude();
			await dragLines(diffLines('after')[3]!, diffLines('after')[5]!);
			const posts = await chipSelectionsAfter(postsBeforeLate, last => /after\.ts$/.test(last?.filePath ?? '') && !!last?.selectedText && last.startLine === 4);
			await check('a SemanticDiff page set past the bridge\'s setter still reaches Claude Code', async () =>
				await postsToClaude() > postsBeforeLate && posts.at(-1)?.startLine === 4 && lf(posts.at(-1)?.selectedText) === diffText('after', 4, 6) || JSON.stringify(posts.at(-1)).slice(0, 300));
			await closeSemanticDiff();
		}
		await call('execute_command', { command: 'standin.close' });

		// The README's setting links reach the bridge as vscode:// links; --open-url hands one to this test instance only.
		const openSettingsLink = (url: string) => spawnSync(exe, ['--open-url', url, `--user-data-dir=${join(run, 'user-data')}`, `--extensions-dir=${join(run, 'extensions')}`], { env, timeout: 30_000 });
		const activeLabel = async () => (await tab() as { label?: string }).label;
		const waitForLabel = async (label: string) => {
			for (const end = Date.now() + 15_000; Date.now() < end; await sleep(500)) {
				if (await activeLabel() === label) {
					return true;
				}
			}
			return false;
		};
		openSettingsLink('vscode://klaster1.vscode-bridge-for-claude-code/settings?id=vscodeBridge.enabled&url=vscode%3A%2F%2Fklaster1.vscode-bridge-for-claude-code%2Fsettings%3Fid%3DvscodeBridge.enabled');
		results.push({ name: 'a setting link opens the Settings editor', ok: await waitForLabel('Settings'), note: `active tab: ${await activeLabel()}` });
		await call('execute_command', { command: 'workbench.action.closeActiveEditor' });
		openSettingsLink('vscode://klaster1.vscode-bridge-for-claude-code/settings?id=workbench.colorTheme');
		await sleep(5000);
		results.push({ name: 'a link to another extension\'s setting is ignored', ok: await activeLabel() !== 'Settings' && /Ignored the link/.test(bridgeLog()), note: `active tab: ${await activeLabel()}` });
	}

	// Terminal: run a command through the keyboard-input command, then read it back.
	await check('terminal setup', async () => {
		await call('execute_command', { command: 'workbench.action.terminal.new' });
		await sleep(8000);
		await call('execute_command', { command: 'workbench.action.terminal.sendSequence', args: [{ text: 'echo bridge-marker-42\r' }] });
		await sleep(4000);
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
				await sleep(300);
			}
			console.log(`
${label}: ${changes.join(', ')}`);
			return !!last;
		};
		await call('execute_command', { command: 'workbench.action.browser.open', args: [userUrl] });
		await sleep(3000);
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
	await cdp?.close().catch(() => undefined); // Disconnects; VS Code stops with taskkill below.
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
