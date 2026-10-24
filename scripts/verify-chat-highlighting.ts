// Checks the chat syntax highlighting against the real Claude Code extension, on Windows, in an
// isolated VS Code: this extension from source, a copy of the newest installed Claude Code, and an
// API stub that streams one canned reply and fails everything else, so no model is called. Run it
// after a Claude Code or VS Code update, as the notes on the runtime patches ask. It exits 1 when
// a scenario fails and saves a shot of each one.
//
//   node scripts/verify-chat-highlighting.ts [shots folder] [--only=static|stream|restore|sidebar]
//
//   static    a past session's code blocks get colors, and follow the theme when it changes
//   stream    a reply that streams in, token by token, is colored while it arrives
//   restore   a chat tab that VS Code restores at window start is colored
//   sidebar   the chat in the secondary side bar is colored

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { _electron, type ElectronApplication, type Frame, type Page } from 'playwright';
import { discoveryFile } from '../plugin/scripts/discovery.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const shots = process.argv.slice(2).find(a => !a.startsWith('--')) ?? join(root, '.vscode-test', 'chat-highlighting-shots');
const only = process.argv.find(a => a.startsWith('--only='))?.slice('--only='.length);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
// A previous run's folder can stay locked for a while after its windows close, so a run that cannot clear it works in a new one.
let run = join(root, '.vscode-test', 'chat-highlighting');
try {
	rmSync(run, { recursive: true, force: true, maxRetries: 10 });
} catch {
	run = `${run}-${Date.now()}`;
}
mkdirSync(shots, { recursive: true });
const home = join(run, 'home');
const workspace = join(home, 'weather-app');
const claudeConfig = join(home, '.claude');
const userData = join(run, 'user-data');
const extensions = join(run, 'extensions');
for (const dir of [join(userData, 'User'), extensions, claudeConfig, join(home, 'AppData', 'Roaming'), join(home, 'AppData', 'Local')]) {
	mkdirSync(dir, { recursive: true });
}
cpSync(join(root, 'scripts', 'screenshot-fixture'), workspace, { recursive: true });

const claudeCode = join(homedir(), '.vscode', 'extensions', readdirSync(join(homedir(), '.vscode', 'extensions')).filter(n => /^anthropic\.claude-code-\d/.test(n))
	.sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).at(-1)!);
const version = (JSON.parse(readFileSync(join(claudeCode, 'package.json'), 'utf8')) as { version: string }).version;
console.log(`Claude Code ${version} from ${claudeCode}`);
cpSync(claudeCode, join(extensions, claudeCode.split(/[\\/]/).at(-1)!), { recursive: true });
const apiKey = 'sk-ant-api03-verify-stub-000000000000000000000';
writeFileSync(join(claudeConfig, '.claude.json'), JSON.stringify({
	hasCompletedOnboarding: true, lastOnboardingVersion: version, lastReleaseNotesSeen: version, lastClawdEntranceVersion: version,
	hasIdeAutoConnectDialogBeenShown: true, hasSeenAutoDefaultNotice: true, hasSeenAutoModeEntryWarning: true,
	customApiKeyResponses: { approved: [apiKey.slice(-20)], rejected: [] },
	projects: { [workspace.replaceAll('\\', '/')]: { hasTrustDialogAccepted: true, allowedTools: [] } },
}, null, 2));
writeFileSync(join(claudeConfig, 'settings.json'), JSON.stringify({ prefersReducedMotion: true }));

const fence = '```';
const reply = [
	'The lookup is cached for ten minutes. This is the function:',
	'',
	`${fence}typescript`,
	'interface Forecast { city: string; hours: number[] }',
	'',
	'/** Returns the cached forecast, or fetches a new one. */',
	'export async function getForecast(city: string): Promise<Forecast> {',
	'  const cached = cache.get(city); // ten minute TTL',
	'  if (cached && Date.now() - cached.at < 600_000) {',
	'    return cached.value;',
	'  }',
	'  const response = await fetch(`/forecast?city=${encodeURIComponent(city)}`);',
	'  return (await response.json()) as Forecast;',
	'}',
	fence,
	'',
	'The same check in Python, and the setting that controls it:',
	'',
	`${fence}python`,
	'def get_forecast(city: str) -> dict:',
	'    """Return the cached forecast."""',
	'    hit = CACHE.get(city)',
	'    if hit and time.time() - hit["at"] < 600:',
	'        return hit["value"]',
	'    return fetch(city)',
	fence,
	'',
	`${fence}json`,
	'{ "cache": { "ttlSeconds": 600, "enabled": true }, "cities": ["Oslo", "Lima"] }',
	fence,
	'',
	'And the change that sets the new time:',
	'',
	`${fence}diff`,
	'-  if (cached && Date.now() - cached.at < 300_000) {',
	'+  if (cached && Date.now() - cached.at < 600_000) {',
	fence,
	'',
	`${fence}bash`,
	'npm test -- --grep "forecast cache" && echo "done"',
	fence,
].join('\n');
const sessionId = '6a1d3b9e-2f40-4c7a-8e15-9b0d4c2f7a31';
const question = 'Show me the forecast cache code.';
{
	const base = { isSidechain: false, userType: 'external', entrypoint: 'claude-vscode', cwd: workspace, sessionId, version };
	const records = [
		{ ...base, parentUuid: null, type: 'user', uuid: 'b1000000-0000-4000-8000-000000000001', timestamp: '2026-10-01T09:00:00.000Z', message: { role: 'user', content: question } },
		{
			...base, parentUuid: 'b1000000-0000-4000-8000-000000000001', type: 'assistant', uuid: 'b1000000-0000-4000-8000-000000000002', timestamp: '2026-10-01T09:00:05.000Z',
			message: { id: 'msg_verify', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 }, content: [{ type: 'text', text: reply }] },
		},
		{ type: 'last-prompt', lastPrompt: question, leafUuid: 'b1000000-0000-4000-8000-000000000002', sessionId },
	];
	const folder = join(claudeConfig, 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-'));
	mkdirSync(folder, { recursive: true });
	writeFileSync(join(folder, `${sessionId}.jsonl`), records.map(r => JSON.stringify(r)).join('\n') + '\n');
}

const settingsFile = join(userData, 'User', 'settings.json');
const writeSettings = (theme: string) => writeFileSync(settingsFile, JSON.stringify({
	'workbench.colorTheme': theme, 'window.zoomLevel': 0, 'security.workspace.trust.enabled': false,
	'update.mode': 'none', 'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none', 'workbench.reduceMotion': 'on',
	'workbench.layoutControl.enabled': false, 'chat.commandCenter.enabled': false,
	'extensions.ignoreRecommendations': true, 'editor.minimap.enabled': false, 'breadcrumbs.enabled': false,
	'claudeCode.hideOnboarding': true, 'claudeCode.showMessageTimestamps': false,
}, null, 2));
writeSettings('Dark Modern');

// Answers the one streaming request a message in the chat sends, token by token; every other request fails.
const apiRequests: string[] = [];
const streamed = (reply2: string, write: (chunk: string) => Promise<void>) => (async () => {
	const send = (event: string, data: unknown) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	await send('message_start', { type: 'message_start', message: { id: 'msg_stream', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
	await send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
	for (let i = 0; i < reply2.length; i += 14) {
		await send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply2.slice(i, i + 14) } });
		await sleep(60);
	}
	await send('content_block_stop', { type: 'content_block_stop', index: 0 });
	await send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 80 } });
	await send('message_stop', { type: 'message_stop' });
})();
const api = createServer((req, res) => {
	const body: Buffer[] = [];
	req.on('data', c => body.push(c as Buffer));
	req.on('end', () => {
		apiRequests.push(`${req.method} ${req.url}`);
		let wantsStream = false;
		try {
			wantsStream = (JSON.parse(Buffer.concat(body).toString('utf8')) as { stream?: boolean }).stream === true && /^\/v1\/messages/.test(req.url ?? '');
		} catch {
			// Not JSON.
		}
		if (!wantsStream) {
			res.writeHead(401, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'verify stub' } }));
			return;
		}
		res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
		void streamed(reply, async chunk => { res.write(chunk); }).then(() => res.end());
	});
});
await new Promise<void>(r => api.listen(0, '127.0.0.1', r));

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
	if (v !== undefined && !/^(VSCODE_|ELECTRON_|CLAUDE|ANTHROPIC_|MCP_)/.test(k)) {
		env[k] = v;
	}
}
Object.assign(env, {
	USERPROFILE: home, HOME: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
	CLAUDE_CONFIG_DIR: claudeConfig, ANTHROPIC_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}`, ANTHROPIC_API_KEY: apiKey,
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
});
process.env['LOCALAPPDATA'] = env['LOCALAPPDATA'];
const exe = await downloadAndUnzipVSCode({ version: '1.143.1', cachePath: join(root, '.vscode-test') });

interface Window { app: ElectronApplication; page: Page; command: (id: string, ...args: unknown[]) => Promise<void>; frameWith: (selector: string, ms?: number) => Promise<Frame>; close: () => Promise<void> }

let current: Window | undefined;
let launches = 0;
async function launch(): Promise<Window> {
	const app = await _electron.launch({
		executablePath: exe,
		args: [workspace, `--extensionDevelopmentPath=${root}`, `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`, '--disable-workspace-trust',
			'--skip-welcome', '--skip-release-notes', '--new-window', '--force-device-scale-factor=2', '--enable-proposed-api=klaster1.vscode-bridge-for-claude-code'],
		env, timeout: 90_000,
	});
	const page = await app.firstWindow();
	await page.waitForSelector('.monaco-workbench', { timeout: 90_000 });
	const window = await app.browserWindow(page);
	await window.evaluate((w: { setContentSize(width: number, height: number): void }) => w.setContentSize(1100, 900));
	const bridge = discoveryFile(workspace);
	for (let i = 0; i < 180 && !existsSync(bridge); i++) {
		await sleep(500);
	}
	let client: Client | undefined;
	const connect = async () => {
		client = new Client({ name: 'verify', version: '0' });
		await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'plugin', 'launcher.mjs')], cwd: workspace, env }));
	};
	await connect();
	current = {
		app, page,
		command: async (id, ...args) => {
			const result = await client!.callTool({ name: 'execute_command', arguments: { command: id, args } });
			if (result.isError) {
				throw new Error(`${id}: ${JSON.stringify(result.content)}`);
			}
		},
		frameWith: async (selector, ms = 30_000) => {
			for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
				for (const frame of page.frames()) {
					if (await frame.locator(selector).count().catch(() => 0)) {
						return frame;
					}
				}
			}
			throw new Error(`No frame has ${selector}`);
		},
		close: async () => {
			await page.screenshot({ path: join(shots, `last-${++launches}.png`) }).catch(() => undefined); // What the window showed when its scenario ended.
			await client?.close().catch(() => undefined);
			await app.close().catch(() => undefined);
		},
	};
	return current;
}

type Globals = { CSS: { highlights: Map<string, { size: number }> } };
/** The colors painted on the page's code blocks: each Highlight's name and how many ranges it holds. */
const painted = (frame: Frame): Promise<Record<string, number>> => frame.evaluate(() =>
	Object.fromEntries([...(globalThis as unknown as Globals).CSS.highlights.entries()].map(([name, h]) => [name.replace(/^vscb-/, ''), h.size])));
const rangeCount = (colors: Record<string, number>) => Object.values(colors).reduce((a, b) => a + b, 0);
/** Dismisses the banners and the notice about the default permission mode, which sit over the chat. */
const clearNotices = async (claude: Frame) => {
	for (const close of await claude.locator('[aria-label="Close banner"]').all()) {
		await close.click();
	}
	const notice = claude.getByText("Auto mode is now Claude Code's default permission mode.");
	if (await notice.waitFor({ timeout: 5000 }).then(() => true, () => false)) {
		await notice.locator('xpath=..').getByRole('button').click();
		await notice.waitFor({ state: 'detached' });
	}
};
const openSession = async (w: Window, target?: Frame) => {
	const claude = target ?? await w.frameWith('[aria-label="Send message"]');
	await clearNotices(claude);
	await claude.getByRole('button', { name: 'Session history' }).click();
	await claude.getByText(question).first().click();
	await claude.locator('pre > code[class*="language-"]').first().waitFor({ timeout: 30_000 });
	return claude;
};
const waitForColors = async (frame: Frame, wanted: string[], ms = 15_000): Promise<Record<string, number>> => {
	let colors: Record<string, number> = {};
	for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
		colors = await painted(frame);
		if (wanted.every(c => colors[c])) {
			return colors;
		}
	}
	return colors;
};

/** Forgets the open editors, so a scenario starts with no chat tab restored. */
const forgetWindow = () => {
	for (const path of [join(userData, 'User', 'workspaceStorage'), join(userData, 'Backups')]) {
		rmSync(path, { recursive: true, force: true, maxRetries: 10 });
	}
};

const results: { name: string; ok: boolean; note: string }[] = [];
const record = (name: string, ok: boolean, note: string) => {
	results.push({ name, ok, note });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  -- ${note}`);
};
const darkKeyword = '569CD6', lightKeyword = '0000FF', monokaiKeyword = 'F92672';
const scenarios: Record<string, () => Promise<void>> = {
	async static() {
		const w = await launch();
		try {
			await w.command('claude-vscode.editor.open');
			const claude = await openSession(w);
			let colors = await waitForColors(claude, [darkKeyword]);
			record('static: a past session is colored in Dark Modern', !!colors[darkKeyword], `${rangeCount(colors)} ranges, ${Object.keys(colors).length} colors`);
			await w.page.screenshot({ path: join(shots, 'static-dark.png') });
			writeSettings('Light Modern');
			colors = await waitForColors(claude, [lightKeyword]);
			record('static: the colors follow a switch to Light Modern', !!colors[lightKeyword] && !colors[darkKeyword], Object.keys(colors).join(','));
			await w.page.screenshot({ path: join(shots, 'static-light.png') });
			writeSettings('Monokai');
			colors = await waitForColors(claude, [monokaiKeyword]);
			record('static: the colors follow a switch to Monokai', !!colors[monokaiKeyword] && !colors[lightKeyword], Object.keys(colors).join(','));
			await w.page.screenshot({ path: join(shots, 'static-monokai.png') });
			writeSettings('Dark Modern');
		} finally {
			await w.close();
		}
	},
	async stream() {
		const w = await launch();
		try {
			await w.command('claude-vscode.editor.open');
			const claude = await w.frameWith('[aria-label="Send message"]');
			await clearNotices(claude);
			await claude.getByRole('textbox').first().click();
			await w.page.keyboard.type('Show me the cache code.');
			await claude.getByRole('button', { name: 'Send message' }).click();
			await claude.locator('pre > code[class*="language-"]').first().waitFor({ timeout: 30_000 });
			const samples: number[] = [];
			for (let i = 0; i < 80; i++) {
				const colors = await painted(claude);
				samples.push(rangeCount(colors));
				if (i === 12) {
					await w.page.screenshot({ path: join(shots, 'stream-middle.png') });
				}
				const blocks = await claude.locator('pre > code[class*="language-"]').count();
				if (blocks >= 5 && samples.length > 20 && samples.at(-1) === samples.at(-6)) {
					break;
				}
				await sleep(250);
			}
			const during = samples.filter(n => n > 0).length;
			const growing = samples.some((n, i) => i > 0 && n > samples[i - 1]! && samples[i - 1]! > 0);
			const final = await waitForColors(claude, [darkKeyword]);
			record('stream: a block is colored while the reply is still arriving', during > 3 && growing, `samples ${samples.join(' ')}`);
			record('stream: the finished reply is fully colored', !!final[darkKeyword] && rangeCount(final) >= 80, `${rangeCount(final)} ranges`);
			await w.page.screenshot({ path: join(shots, 'stream-final.png') });
		} finally {
			await w.close();
		}
	},
	async restore() {
		const first = await launch();
		try {
			await first.command('claude-vscode.editor.open');
			await openSession(first);
			await sleep(1500);
			await first.app.evaluate(({ app }: { app: { quit(): void } }) => app.quit()).catch(() => undefined);
			await first.app.waitForEvent('close', { timeout: 60_000 }).catch(() => undefined);
		} finally {
			await first.close();
		}
		await sleep(2000);
		const w = await launch();
		try {
			const claude = await w.frameWith('pre > code[class*="language-"]', 60_000);
			const colors = await waitForColors(claude, [darkKeyword]);
			record('restore: a chat tab restored at window start is colored', !!colors[darkKeyword], `${rangeCount(colors)} ranges`);
			await w.page.screenshot({ path: join(shots, 'restore.png') });
		} finally {
			await w.close();
		}
	},
	async sidebar() {
		const w = await launch();
		try {
			await w.command('claude-vscode.sidebar.open');
			const claude = await openSession(w);
			const colors = await waitForColors(claude, [darkKeyword]);
			record('sidebar: the chat in a side bar is colored', !!colors[darkKeyword], `${rangeCount(colors)} ranges`);
			await w.page.screenshot({ path: join(shots, 'sidebar.png') });
		} finally {
			await w.close();
		}
	},
};

try {
	for (const [name, scenario] of Object.entries(scenarios)) {
		if (!only || only === name) {
			forgetWindow();
			try {
				await scenario();
			} catch (err) {
				record(`${name}: ran to the end`, false, err instanceof Error ? err.message.split('\n')[0]! : String(err));
			}
		}
	}
} finally {
	api.close();
}
// Claude Code logs each message its chat page posts, naming each field and giving no values; the page's requests have a `lang` field.
const logs = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? logs(join(dir, e.name)) : e.name === 'Claude VSCode.log' ? [join(dir, e.name)] : []);
const leaked = logs(join(userData, 'logs')).filter(file => /Received message from webview: \{[^\n]*"lang":/.test(readFileSync(file, 'utf8')));
record('quiet: no highlight request reached Claude Code', leaked.length === 0, leaked.length ? `${leaked.length} logs show them` : 'no Claude Code log shows one');
console.log(`Requests that reached the API stub: ${apiRequests.length}, streamed answers: ${apiRequests.filter(r => /messages/.test(r)).length}`);
process.exit(results.some(r => !r.ok) ? 1 : 0);
