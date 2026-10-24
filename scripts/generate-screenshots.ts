// Generates the README screenshots in docs/screenshots/ and the social preview docs/social.png
// from an isolated VS Code: the build test/run.ts uses, with its own home, user-data and
// extensions folders, this extension packaged from the working tree, and a copy of the Claude
// Code extension installed for the current user. The workspace is scripts/screenshot-fixture.
// On success it records the inputs' hash for check-screenshots.ts.
//
//   npm run screenshots      (Windows, Node 22.18+; about a minute, in VS Code windows kept off-screen)
//
// Claude Code runs signed in with a dummy API key against a local stub that answers every
// request with 401, so no prompt reaches a model. The user's ~/.claude, ~/.claude.json, VS Code
// profile and extensions are only read: the Claude Code extension folder is copied.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from '@vscode/test-electron';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { _electron, type Frame, type Locator } from 'playwright';
import { discoveryFile } from '../plugin/scripts/discovery.ts';
import { commandLine } from '../src/shell.ts';
import { keepUrlHandler } from '../test/url-handler.ts';
import { hashInputs, recordFile, type InputRecord } from './screenshot-inputs.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const run = join(root, '.vscode-test', 'screenshots');
const userData = join(run, 'user-data');
const extensions = join(run, 'extensions');
const out = join(root, 'docs', 'screenshots');
const pagePort = 4173; // Shows in the browser's address bar, so it is fixed.
const apiKey = 'sk-ant-api03-screenshot-stub-0000000000000000';

// Page globals, typed here because the repo's tsconfig has no DOM lib.
type PageGlobals = { innerWidth: number; innerHeight: number; requestAnimationFrame(callback: () => void): number };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const posix = (path: string) => path.replaceAll('\\', '/');
const started = Date.now();

// The isolated home is a drive of its own, so the paths the CLI prints, such as Z:\weather-app, hold no local folder names.
const homeFolder = join(run, 'home');
const unmapHome = () => {
	for (const line of spawnSync('subst', [], { encoding: 'utf8' }).stdout.split(/\r?\n/)) {
		const mapped = /^([A-Z]:)\\: => (.+)$/.exec(line);
		if (mapped && mapped[2]!.toLowerCase() === homeFolder.toLowerCase()) {
			spawnSync('subst', [mapped[1]!, '/d']);
		}
	}
};
unmapHome(); // Left by a run that was killed.
rmSync(run, { recursive: true, force: true, maxRetries: 10 }); // Retries while a previous run's processes let go of their files.
mkdirSync(homeFolder, { recursive: true });
const drive = [...'ZYXWVUTSRQPONMLKJ'].find(letter => !existsSync(`${letter}:\\`));
if (!drive || spawnSync('subst', [`${drive}:`, homeFolder]).status !== 0) {
	throw new Error('Could not map the isolated home folder to a free drive letter with subst.');
}
process.on('exit', unmapHome);
const home = `${drive}:\\`;
const workspace = join(home, 'weather-app');
const claudeConfig = join(home, '.claude');
mkdirSync(join(userData, 'User'), { recursive: true });
mkdirSync(extensions, { recursive: true });
mkdirSync(claudeConfig, { recursive: true });
mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true });
mkdirSync(join(home, 'AppData', 'Local'), { recursive: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, 'scripts', 'screenshot-fixture'), workspace, { recursive: true });

const claudeCode = (() => {
	const dir = join(homedir(), '.vscode', 'extensions');
	const found = readdirSync(dir).filter(n => /^anthropic\.claude-code-\d/.test(n))
		.sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).at(-1);
	if (!found) {
		throw new Error(`Install Claude Code's VS Code extension first: none found in ${dir}.`);
	}
	return join(dir, found);
})();
const claudeCodeVersion = (JSON.parse(readFileSync(join(claudeCode, 'package.json'), 'utf8')) as { version: string }).version;
console.log(`Claude Code ${claudeCodeVersion} from ${claudeCode}`);
const claudeCodeCopy = join(extensions, claudeCode.split(/[\\/]/).at(-1)!);
cpSync(claudeCode, claudeCodeCopy, { recursive: true });
const claudeExe = join(claudeCodeCopy, 'resources', 'native-binary', 'claude.exe');

// The flags skip the CLI's first-run screens and one-time notices.
writeFileSync(join(claudeConfig, '.claude.json'), JSON.stringify({
	hasCompletedOnboarding: true,
	lastOnboardingVersion: claudeCodeVersion,
	lastReleaseNotesSeen: claudeCodeVersion,
	lastClawdEntranceVersion: claudeCodeVersion, // Without it the mascot plays a random entrance pose.
	hasIdeAutoConnectDialogBeenShown: true,
	hasSeenAutoDefaultNotice: true,
	hasSeenAutoModeEntryWarning: true,
	customApiKeyResponses: { approved: [apiKey.slice(-20)], rejected: [] },
	projects: { [posix(workspace)]: { hasTrustDialogAccepted: true, allowedTools: [] } },
}, null, 2));
writeFileSync(join(claudeConfig, 'settings.json'), JSON.stringify({ theme: 'light', prefersReducedMotion: true }, null, 2));

// Past sessions, which the chat shots open, so no shot needs a model reply. The panel lists the
// sessions in this folder, named after the cwd with each non-alphanumeric as '-'.
const seedSession = (sessionId: string, uuidPrefix: string, question: string, reply: string) => {
	const base = { isSidechain: false, userType: 'external', entrypoint: 'claude-vscode', cwd: workspace, sessionId, version: claudeCodeVersion };
	const asked = `${uuidPrefix}-0000-4000-8000-000000000001`, answered = `${uuidPrefix}-0000-4000-8000-000000000002`;
	const records = [
		{ ...base, parentUuid: null, type: 'user', uuid: asked, timestamp: '2026-10-01T09:00:00.000Z', message: { role: 'user', content: question } },
		{
			...base, parentUuid: asked, type: 'assistant', uuid: answered, timestamp: '2026-10-01T09:00:05.000Z',
			message: {
				id: 'msg_screenshot', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null,
				usage: { input_tokens: 0, output_tokens: 0 },
				content: [{ type: 'text', text: reply }],
			},
		},
		{ type: 'last-prompt', lastPrompt: question, leafUuid: answered, sessionId },
	];
	const folder = join(claudeConfig, 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-'));
	mkdirSync(folder, { recursive: true });
	writeFileSync(join(folder, `${sessionId}.jsonl`), records.map(r => JSON.stringify(r)).join('\n') + '\n');
};
// A reply with a file link, for the chat-link shot.
seedSession('5f0c2a8e-7d41-4b6a-9e3f-2c8d1a7b6e40', 'a1000000', 'Where is the forecast cache documented?',
	'The "Caching" section of [forecast-api.md](docs/forecast-api.md) covers it: a forecast stays in the cache for ten minutes. The code is in [forecast.ts](src/forecast.ts).');
// A reply with code blocks, for the syntax highlighting shot.
const fence = '```';
const codeQuestion = 'Show the forecast cache code.';
seedSession('8b3e5d71-4a92-4c0f-b6d8-1e7f9a2c4d63', 'a2000000', codeQuestion, [
	'The cache lives in forecast.ts. A forecast stays in it for ten minutes:',
	'',
	`${fence}typescript`,
	'const cacheMs = 10 * 60 * 1000; // Ten minutes.',
	'',
	'export async function forecast(city: string): Promise<HourlyForecast[]> {',
	'  const hit = cache.get(city);',
	'  if (hit && Date.now() - hit.at < cacheMs) {',
	'    return hit.hours;',
	'  }',
	'  const response = await fetch(`/forecast?city=${encodeURIComponent(city)}`);',
	'  const hours = (await response.json()) as HourlyForecast[];',
	'  cache.set(city, { at: Date.now(), hours });',
	'  return hours;',
	'}',
	fence,
	'',
	'To keep a forecast for five minutes, change one line:',
	'',
	`${fence}diff`,
	'-const cacheMs = 10 * 60 * 1000; // Ten minutes.',
	'+const cacheMs = 5 * 60 * 1000; // Five minutes.',
	fence,
].join('\n'));

writeFileSync(join(userData, 'User', 'settings.json'), JSON.stringify({
	'workbench.colorTheme': 'Default Light Modern',
	'window.zoomLevel': 0,
	'window.dialogStyle': 'custom', // Renders dialogs in the page, where Playwright can press their buttons.
	'window.restoreWindows': 'none',
	'security.workspace.trust.enabled': false,
	'update.mode': 'none',
	'telemetry.telemetryLevel': 'off',
	'workbench.startupEditor': 'none',
	'workbench.tips.enabled': false,
	'workbench.reduceMotion': 'on',
	'workbench.editor.useModal': 'off', // Settings open as a tab, not a dialog.
	'workbench.secondarySideBar.defaultVisibility': 'hidden',
	'workbench.layoutControl.enabled': false,
	'workbench.editorAssociations': { '*.md': 'vscode.markdown.editor' },
	'extensions.ignoreRecommendations': true,
	'git.openRepositoryInParentFolders': 'never',
	'chat.commandCenter.enabled': false,
	'chat.agent.enabled': true,
	'workbench.browser.enableChatTools': true,
	'editor.cursorBlinking': 'solid',
	'editor.minimap.enabled': false,
	'breadcrumbs.enabled': false,
	'terminal.integrated.cursorBlinking': false,
	'terminal.integrated.gpuAcceleration': 'off', // The DOM renderer, whose text the script waits on.
	'terminal.integrated.profiles.windows': { claude: { path: claudeExe } },
	'terminal.integrated.defaultProfile.windows': 'claude',
	'claudeCode.hideOnboarding': true,
	'claudeCode.showMessageTimestamps': false,
}, null, 2));

// No request may reach a model: every Claude Code call goes to this stub and fails.
const apiRequests: string[] = [];
const api = createServer((req, res) => {
	apiRequests.push(`${req.method} ${req.url}`);
	res.writeHead(401, { 'content-type': 'application/json' });
	res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'screenshot stub' } }));
});
await new Promise<void>(r => api.listen(0, '127.0.0.1', r));

// Serves the fixture's page to the integrated browser, and the social preview with the shots it shows.
const pages = createServer((req, res) => {
	const preview = /^\/(scripts\/social-preview\.html|icon\.png|docs\/screenshots\/[\w-]+\.png)$/.exec(req.url ?? '')?.[1];
	res.writeHead(200, { 'content-type': preview?.endsWith('.png') ? 'image/png' : 'text/html; charset=utf-8' });
	res.end(readFileSync(preview ? join(root, preview) : join(workspace, 'public', 'index.html')));
});
await new Promise<void>((resolve, reject) => {
	pages.once('error', e => reject(new Error(`Port ${pagePort} is taken; the browser shot shows it in the address bar. ${e.message}`)));
	pages.listen(pagePort, '127.0.0.1', resolve);
});

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
	// Variables from a parent VS Code or Claude Code would point this instance at the user's own.
	if (v !== undefined && !/^(VSCODE_|ELECTRON_|CLAUDE|ANTHROPIC_|MCP_)/.test(k)) {
		env[k] = v;
	}
}
Object.assign(env, {
	USERPROFILE: home,
	HOME: home,
	APPDATA: join(home, 'AppData', 'Roaming'),
	LOCALAPPDATA: join(home, 'AppData', 'Local'),
	CLAUDE_CONFIG_DIR: claudeConfig, // Also keeps the CLI off the user's stored sign-in, which it looks up by this folder.
	ANTHROPIC_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
	ANTHROPIC_API_KEY: apiKey,
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
	DISABLE_AUTOUPDATER: '1',
});
// The bridge's default discovery folder is under LOCALAPPDATA, so it is isolated too. A
// VSCODE_BRIDGE_DIR would not reach the CLI: VS Code drops VSCODE_* variables from terminals.
process.env['LOCALAPPDATA'] = env['LOCALAPPDATA'];
// The plugin from the working tree, as `npm run setup` installs it: it loads in place.
for (const args of [['plugin', 'marketplace', 'add', root], ['plugin', 'install', 'vscode-bridge@vscode-bridge']]) {
	const result = spawnSync(claudeExe, args, { env, encoding: 'utf8' });
	if (result.status !== 0) {
		throw new Error(`claude ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
	}
}

const inputs = hashInputs(root); // Before packaging, so the record matches the code the shots show.
const vscodeVersion = '1.143.1';
const exe = await downloadAndUnzipVSCode({ version: vscodeVersion, cachePath: join(root, '.vscode-test') });
keepUrlHandler();
// Installed from a VSIX, as users get it: --extensionDevelopmentPath would put "[Extension Development Host]" in the title.
const vsix = join(run, 'vscode-bridge-for-claude-code.vsix');
const packaged = spawnSync(process.execPath, [join(root, 'node_modules', '@vscode', 'vsce', 'vsce'), 'package', '--allow-missing-repository', '--allow-star-activation', '--no-rewrite-relative-links', '--out', vsix], { cwd: root, encoding: 'utf8' });
if (packaged.status !== 0) {
	throw new Error(`vsce package failed:\n${packaged.stdout}\n${packaged.stderr}`);
}
const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(exe).filter(a => !/^--(user-data|extensions)-dir=/.test(a));
const installed = spawnSync(commandLine(cli!, [...cliArgs, `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`, '--install-extension', vsix]), { env, encoding: 'utf8', shell: true });
if (!/successfully installed/.test(installed.stdout)) {
	throw new Error(`Installing the VSIX failed:\n${installed.stdout}\n${installed.stderr}`);
}

const app = await _electron.launch({
	executablePath: exe,
	args: [
		workspace,
		`--user-data-dir=${userData}`,
		`--extensions-dir=${extensions}`,
		'--disable-workspace-trust',
		'--skip-welcome',
		'--skip-release-notes',
		'--new-window',
		'--enable-proposed-api=klaster1.vscode-bridge-for-claude-code', // Without it the bridge's read of a shared page's selection raises a confirmation dialog over the shot.
		'--force-device-scale-factor=2', // Same pixels on every display, sharp when GitHub scales the image down.
		// The windows sit off-screen (below). Chromium would stop painting a window it counts as hidden.
		'--disable-backgrounding-occluded-windows',
		'--disable-renderer-backgrounding',
		'--disable-features=CalculateNativeWinOcclusion',
	],
	env,
	timeout: 90_000,
});
// Keeps this instance's windows off the user's screen: each one moves to -32000,-32000 when it is
// created, and back there whenever VS Code shows or moves it. Playwright holds the app's ready event
// until it connects, so this runs before VS Code opens its first window.
type MovableWindow = { getPosition(): number[]; setPosition(x: number, y: number): void; on(event: 'show' | 'move', listener: () => void): void };
type ElectronMain = { app: { on(event: 'browser-window-created', listener: (event: unknown, window: MovableWindow) => void): void }; BrowserWindow: { getAllWindows(): MovableWindow[] } };
await app.evaluate(({ app: main, BrowserWindow }: ElectronMain) => {
	const away = (window: MovableWindow) => {
		if ((window.getPosition()[0] ?? 0) > -30000) {
			window.setPosition(-32000, -32000);
		}
	};
	const keepAway = (window: MovableWindow) => {
		away(window);
		window.on('show', () => away(window));
		window.on('move', () => away(window));
	};
	BrowserWindow.getAllWindows().forEach(keepAway);
	main.on('browser-window-created', (_event, window) => keepAway(window));
});
let client: Client | undefined;
const shots: string[] = [];
try {
	const page = await app.firstWindow();
	await page.waitForSelector('.monaco-workbench', { timeout: 90_000 });
	const window = await app.browserWindow(page);
	type ElectronWindow = { setContentSize(width: number, height: number): void; getContentSize(): number[] };
	const resize = async (width: number, height: number) => {
		// The frameless window's content comes out a pixel short of what setContentSize asks for, so ask again with the difference added.
		const got = await window.evaluate((w: ElectronWindow, size: number[]) => { w.setContentSize(size[0]!, size[1]!); return w.getContentSize(); }, [width, height]);
		await window.evaluate((w: ElectronWindow, size: number[]) => w.setContentSize(size[0]!, size[1]!), [2 * width - got[0]!, 2 * height - got[1]!]);
		await page.waitForFunction(([w, h]) => { const g = globalThis as unknown as PageGlobals; return g.innerWidth === w && g.innerHeight === h; }, [width, height], { timeout: 5000 });
	};
	await resize(1200, 720);
	const stabilize = '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; } .monaco-editor .cursors-layer { display: none !important; }';
	await page.addStyleTag({ content: stabilize });

	const bridge = discoveryFile(workspace);
	for (let i = 0; i < 180 && !existsSync(bridge); i++) {
		await sleep(500);
	}
	client = new Client({ name: 'screenshots', version: '0' });
	await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'plugin', 'launcher.mjs')], cwd: workspace, env }));
	const command = async (id: string, ...args: unknown[]) => {
		const result = await client!.callTool({ name: 'execute_command', arguments: { command: id, args } });
		if (result.isError) {
			throw new Error(`${id}: ${JSON.stringify(result.content)}`);
		}
	};

	const frameWith = async (selector: string): Promise<Frame> => {
		for (const end = Date.now() + 30_000; Date.now() < end; await sleep(250)) {
			for (const frame of page.frames()) {
				if (await frame.locator(selector).count().catch(() => 0)) {
					await frame.addStyleTag({ content: stabilize }).catch(() => undefined);
					return frame;
				}
			}
		}
		throw new Error(`No frame has ${selector}`);
	};
	const terminalText = () => page.locator('.terminal-wrapper.active .xterm-rows').innerText().catch(() => '');
	const waitForTerminal = async (pattern: RegExp, ms = 30_000) => {
		for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
			if (pattern.test(await terminalText())) {
				return;
			}
		}
		await page.screenshot({ path: join(run, 'failure.png') });
		throw new Error(`The terminal never showed ${pattern}:\n${await terminalText()}`);
	};
	// Rings and arrows drawn over the page for one shot: a ring on the thing a section is about, an arrow where something travels.
	type Rect = { x: number; y: number; width: number; height: number };
	// An arrow curves (bend: down leaves sideways and arrives from above, across leaves and arrives sideways),
	// or follows via, a path through empty space with rounded corners.
	type Mark = { ring: Rect } | { arrow: { from: [number, number]; to: [number, number]; bend?: 'down' | 'across'; via?: [number, number][] } };
	const markScript = `(marks) => {
	const NS = 'http://www.w3.org/2000/svg';
	const el = (name, attrs) => { const e = document.createElementNS(NS, name); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
	const svg = el('svg', { id: 'bridge-marks', width: innerWidth, height: innerHeight, style: 'position:fixed;left:0;top:0;pointer-events:none;z-index:2147483647;overflow:visible' });
	const defs = el('defs', {});
	svg.appendChild(defs);
	document.body.appendChild(svg);
	marks.forEach((m, i) => {
		if (m.ring) {
			const r = m.ring;
			svg.appendChild(el('rect', { x: r.x - 3, y: r.y - 3, width: r.width + 6, height: r.height + 6, rx: 7, fill: 'none', stroke: 'rgba(236,138,99,0.22)', 'stroke-width': 3 }));
			svg.appendChild(el('rect', { x: r.x, y: r.y, width: r.width, height: r.height, rx: 5, fill: 'none', stroke: '#ec8a63', 'stroke-width': 2, style: 'filter:drop-shadow(0 0 5px rgba(236,138,99,0.8))' }));
			return;
		}
		const [fx, fy] = m.arrow.from, [tx, ty] = m.arrow.to;
		const dx = tx - fx, dy = ty - fy;
		let d, last;
		if (m.arrow.via) {
			const points = [m.arrow.from, ...m.arrow.via, m.arrow.to];
			d = 'M ' + fx + ' ' + fy;
			for (let k = 1; k < points.length - 1; k++) {
				const [px, py] = points[k - 1], [cx, cy] = points[k], [nx, ny] = points[k + 1];
				const before = Math.hypot(cx - px, cy - py), after = Math.hypot(nx - cx, ny - cy);
				const r = Math.min(16, before / 2, after / 2);
				d += ' L ' + (cx - (cx - px) * r / before) + ' ' + (cy - (cy - py) * r / before) + ' Q ' + cx + ' ' + cy + ' ' + (cx + (nx - cx) * r / after) + ' ' + (cy + (ny - cy) * r / after);
			}
			d += ' L ' + tx + ' ' + ty;
			last = points[points.length - 2];
		} else {
			const down = m.arrow.bend === 'down';
			const c1 = down ? [fx + 0.65 * dx, fy] : [fx + 0.5 * dx, fy];
			const c2 = down ? [tx, ty - 0.55 * dy] : [tx - 0.5 * dx, ty];
			d = 'M ' + fx + ' ' + fy + ' C ' + c1[0] + ' ' + c1[1] + ', ' + c2[0] + ' ' + c2[1] + ', ' + tx + ' ' + ty;
			last = c2;
		}
		const gradient = el('linearGradient', { id: 'bridge-flow-' + i, gradientUnits: 'userSpaceOnUse', x1: fx, y1: fy, x2: tx, y2: ty });
		gradient.appendChild(el('stop', { offset: 0, 'stop-color': '#3b9cf5' }));
		gradient.appendChild(el('stop', { offset: 1, 'stop-color': '#e8805f' }));
		defs.appendChild(gradient);
		const glow = 'filter:drop-shadow(0 0 4px rgba(236,138,99,0.7))';
		svg.appendChild(el('path', { d, fill: 'none', stroke: 'url(#bridge-flow-' + i + ')', 'stroke-width': 3.2, 'stroke-dasharray': '0.1 7.5', 'stroke-linecap': 'round', style: glow }));
		const a = Math.atan2(ty - last[1], tx - last[0]);
		const head = [0.7, -0.7].map(s => [tx - 11 * Math.cos(a + s), ty - 11 * Math.sin(a + s)]);
		svg.appendChild(el('path', { d: 'M ' + head[0][0] + ' ' + head[0][1] + ' L ' + tx + ' ' + ty + ' L ' + head[1][0] + ' ' + head[1][1], fill: 'none', stroke: '#e8805f', 'stroke-width': 3.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', style: glow }));
	});
}`;
	const rect = async (target: Locator) => (await target.boundingBox({ timeout: 5000 }))!;
	const ring = (r: Rect, left = 6, top = 4, right = left, bottom = top): { ring: Rect } => ({ ring: { x: r.x - left, y: r.y - top, width: r.width + left + right, height: r.height + top + bottom } });
	const union = (rects: Rect[]): Rect => {
		const x = Math.min(...rects.map(r => r.x)), y = Math.min(...rects.map(r => r.y));
		return { x, y, width: Math.max(...rects.map(r => r.x + r.width)) - x, height: Math.max(...rects.map(r => r.y + r.height)) - y };
	};
	// A block element's box spans its column; this is the box of its text.
	type RangeDocument = { document: { createRange(): { selectNodeContents(node: unknown): void; getBoundingClientRect(): { width: number } } } };
	const textRect = async (target: Locator): Promise<Rect> => {
		const width = await target.evaluate((el: unknown) => {
			const { document } = globalThis as unknown as RangeDocument;
			const range = document.createRange();
			range.selectNodeContents(el);
			return range.getBoundingClientRect().width;
		});
		return { ...(await rect(target)), width };
	};
	const terminalLine = async (pattern: RegExp): Promise<Rect> => {
		const boxes: Rect[] = [];
		for (const run of await panelPart.locator('.xterm-rows > div').filter({ hasText: pattern }).locator('span').all()) {
			const text = (await run.textContent()) ?? '';
			const trimmed = text.trim();
			const box = await run.boundingBox();
			if (box && trimmed && trimmed !== '❯') {
				const cell = box.width / text.length; // A run's box includes its spaces; the font is monospaced.
				boxes.push({ ...box, x: box.x + (text.length - text.trimStart().length) * cell, width: trimmed.length * cell });
			}
		}
		return union(boxes);
	};
	const shoot = async (name: string, parts: Locator[], marks: () => Promise<Mark[]> = async () => []) => {
		await page.mouse.move(-1, -1); // Off the window: nothing shows a hover state or a tooltip.
		await sleep(400);
		await page.evaluate(() => new Promise<void>(r => { const g = globalThis as unknown as PageGlobals; g.requestAnimationFrame(() => g.requestAnimationFrame(r)); }));
		const boxes = await Promise.all(parts.map(async p => (await p.boundingBox())!));
		const x = Math.min(...boxes.map(b => b.x));
		const y = Math.min(...boxes.map(b => b.y));
		const clip = { x, y, width: Math.max(...boxes.map(b => b.x + b.width)) - x, height: Math.max(...boxes.map(b => b.y + b.height)) - y };
		const drawn = await marks();
		if (drawn.length) {
			await page.evaluate(`(${markScript})(${JSON.stringify(drawn)})`);
		}
		await page.screenshot({ path: join(out, name), clip });
		if (drawn.length) {
			await page.evaluate("document.getElementById('bridge-marks')?.remove()");
		}
		shots.push(name);
		console.log(`Saved ${name} at ${Math.round((Date.now() - started) / 1000)} s`);
	};
	const editorPart = page.locator('[id="workbench.parts.editor"]');
	const panelPart = page.locator('.part.panel');

	await command('workbench.action.closeSidebar');
	await command('workbench.action.closePanel');

	const markdownText = 'text=Responses stay in the cache';
	const openMarkdownEditor = async () => {
		await command('vscode.openWith', { $uri: 'docs/forecast-api.md' }, 'vscode.markdown.editor');
		await frameWith(markdownText);
	};
	// Selects the "Caching" section the way a person does: a click, then a Shift+click. The
	// Markdown Editor's frame can be replaced after it opens, so each try looks it up again.
	const selectCaching = async () => {
		for (let attempt = 1; ; attempt++) {
			try {
				const markdown = await frameWith(markdownText);
				const start = (await markdown.getByRole('heading', { name: 'Caching' }).boundingBox({ timeout: 5000 }))!;
				const end = (await markdown.getByText('Responses stay in the cache').boundingBox({ timeout: 5000 }))!;
				await page.mouse.click(start.x + 2, start.y + start.height / 2);
				await page.keyboard.down('Shift');
				await page.mouse.click(end.x + end.width - 2, end.y + end.height - 6);
				await page.keyboard.up('Shift');
				return;
			} catch (e) {
				if (attempt === 3 || !/detached/i.test(String(e))) {
					throw e;
				}
				await sleep(1000);
			}
		}
	};
	const openClaudePanel = async () => {
		await command('claude-vscode.editor.open');
		const claude = await frameWith('[aria-label="Send message"]');
		for (const close of await claude.locator('[aria-label="Close banner"]').all()) {
			await close.click();
		}
		// The panel keeps its own record of this notice, apart from the CLI's flag, and shows it a moment after loading.
		const notice = claude.getByText("Auto mode is now Claude Code's default permission mode.");
		if (await notice.waitFor({ timeout: 5000 }).then(() => true, () => false)) {
			await notice.locator('xpath=..').getByRole('button').click();
			await notice.waitFor({ state: 'detached' });
		}
		return claude;
	};

	// Settings.
	await resize(960, 980);
	await command('workbench.action.openSettings', '@ext:klaster1.vscode-bridge-for-claude-code');
	await page.locator('.settings-editor .setting-item-contents').first().waitFor();
	await sleep(500);
	await page.keyboard.press('End'); // The search box sometimes opens with its text selected.
	await shoot('settings.png', [editorPart]);
	await command('workbench.action.closeAllGroups');
	await resize(1200, 720);

	// The Markdown Editor's selection in Claude Code's selection chip.
	await openMarkdownEditor();
	const claude = await openClaudePanel();
	await selectCaching();
	await claude.getByText(/\d+ lines? selected/).waitFor();
	await shoot('markdown-selection-chip.png', [editorPart], async () => {
		const chip = ring(await rect(claude.getByText(/\d+ lines? selected/)), 26, 6, 26, 6);
		const selection = await rect((await frameWith(markdownText)).getByText('Responses stay in the cache'));
		return [chip, { arrow: { from: [selection.x + selection.width + 8, selection.y + selection.height / 2], to: [chip.ring.x + chip.ring.width / 2, chip.ring.y - 5], bend: 'down' } }];
	});

	// A chat link opening in the Markdown Editor.
	await command('workbench.action.closeAllGroups');
	const resumed = await openClaudePanel();
	await resumed.getByRole('button', { name: 'Session history' }).click();
	await resumed.getByText('Where is the forecast cache documented?').first().click();
	await resumed.getByRole('button', { name: 'Send message' }).and(resumed.locator('[data-permission-mode="auto"]')).waitFor(); // A resumed session shows Manual until its mode loads.
	await resumed.getByRole('link', { name: 'forecast-api.md' }).click();
	await frameWith(markdownText);
	await shoot('chat-link.png', [editorPart], async () => {
		const link = ring(await rect(resumed.getByRole('link', { name: 'forecast-api.md' })), 3, 3);
		const heading = ring(await textRect((await frameWith(markdownText)).getByRole('heading', { name: 'Forecast API' })), 10, 4);
		const reply = await rect(resumed.getByText(/covers it/));
		const down = link.ring.x + link.ring.width - 10; // Right of the reply's second line.
		const below = reply.y + reply.height + 34; // Under the reply's buttons.
		const lane = heading.ring.x - 22; // The opened file's empty left margin.
		const level = heading.ring.y + heading.ring.height / 2;
		return [link, heading, { arrow: { from: [down, link.ring.y + link.ring.height + 3], via: [[down, below], [lane, below], [lane, level]], to: [heading.ring.x - 5, level] } }];
	});
	await command('workbench.action.closeAllGroups');

	// Colored code blocks in Claude Code's chat.
	await openClaudePanel();
	await command('workbench.action.joinAllGroups'); // Claude Code's locked group outlives closeAllGroups, as an empty group beside the chat.
	const coded = await frameWith('[aria-label="Send message"]'); // The move can replace the chat's frame.
	await coded.getByRole('button', { name: 'Session history' }).click();
	await coded.getByText(codeQuestion).first().click();
	await coded.locator('pre > code[class*="language-"]').first().waitFor();
	type HighlightGlobals = { CSS: { highlights: { size: number } } };
	for (const end = Date.now() + 30_000; ; await sleep(250)) { // The colors are CSS highlights, painted after the page loads the grammars.
		if (await coded.evaluate(() => (globalThis as unknown as HighlightGlobals).CSS.highlights.size) > 0) {
			break;
		}
		if (Date.now() > end) {
			throw new Error('The chat painted no code colors.');
		}
	}
	await coded.getByRole('button', { name: 'Send message' }).and(coded.locator('[data-permission-mode="auto"]')).waitFor();
	await coded.locator('pre').first().scrollIntoViewIfNeeded();
	await coded.evaluate(() => (globalThis as unknown as { document: { activeElement: { blur(): void } | null } }).document.activeElement?.blur()); // The moved chat keeps focus in its input, which draws a red border.
	await shoot('chat-syntax-highlighting.png', [editorPart]);
	await command('workbench.action.closeAllGroups');

	// The CLI in the terminal, connected to the window, with the Markdown Editor's selection.
	await openMarkdownEditor();
	await command('workbench.action.joinAllGroups'); // Claude Code's locked group outlives closeAllGroups, as an empty group.
	await command('workbench.action.terminal.new');
	await waitForTerminal(/shift\+tab to cycle/);
	await selectCaching();
	await waitForTerminal(/\d+ lines? selected/);
	await shoot('cli-selection.png', [editorPart, panelPart], async () => {
		return [ring(await terminalLine(/lines? selected/), 4, 3)];
	});

	// /mcp lists vscode-tools as connected.
	await resize(1000, 400);
	await command('workbench.action.toggleMaximizedPanel');
	await command('workbench.action.terminal.focus');
	await page.keyboard.type('/mcp');
	await sleep(500);
	await page.keyboard.press('Enter');
	await waitForTerminal(/vscode-tools\s+\d+ tools/);
	await shoot('mcp-connected.png', [panelPart], async () => {
		return [ring(await terminalLine(/vscode-tools\s+\d+ tools/), 4, 1)];
	});
	await page.keyboard.press('Escape');
	await resize(1200, 720);
	await command('workbench.action.toggleMaximizedPanel');
	await command('workbench.action.closePanel');
	await command('workbench.action.closeAllGroups');

	// A page in the integrated browser, shared with the agent.
	await resize(1000, 470);
	await command('workbench.action.browser.open', `http://localhost:${pagePort}/`);
	await page.getByRole('button', { name: 'Share with Agent' }).click();
	await page.locator('.monaco-dialog-box').getByRole('button', { name: 'Allow' }).click();
	await page.getByText('Sharing with Agent').waitFor();
	await shoot('browser-shared-page.png', [editorPart], async () => [ring(await rect(page.getByText('Sharing with Agent')), 10, 6, 30, 6)]);

	// The repository's social preview, composed from the shots above by scripts/social-preview.html.
	// It renders in a window of this Electron, so it needs no browser download, and loads over HTTP
	// because VS Code's main process blocks file:// pages. The window is larger than the 640×320
	// page because a frameless window's content comes out a pixel short.
	type Electron = { BrowserWindow: new (options: object) => { loadURL(url: string): Promise<void> } };
	const previewOpened = app.waitForEvent('window');
	await app.evaluate(({ BrowserWindow }: Electron, url: string) => {
		void new BrowserWindow({ width: 680, height: 360, useContentSize: true, frame: false, resizable: false }).loadURL(url);
	}, `http://127.0.0.1:${pagePort}/scripts/social-preview.html`);
	const preview = await previewOpened;
	type PreviewDocument = { document: { querySelectorAll(selector: string): { length: number }; images: ArrayLike<{ complete: boolean }> } };
	await preview.waitForFunction(() => {
		const { document } = globalThis as unknown as PreviewDocument;
		return document.querySelectorAll('[data-crop]:not([data-ready])').length === 0 && Array.from(document.images).every(image => image.complete);
	});
	await preview.screenshot({ path: join(root, 'docs', 'social.png'), clip: { x: 0, y: 0, width: 640, height: 320 } });
	shots.push('../social.png');
	console.log('Saved social.png');
} finally {
	await client?.close().catch(() => undefined);
	await app.close();
	api.close();
	pages.close();
}
const record: InputRecord = { ...inputs, images: shots.map(name => posix(relative(root, join(out, name)))).sort(), vscode: vscodeVersion, claudeCode: claudeCodeVersion };
writeFileSync(join(root, recordFile), JSON.stringify(record, null, '\t') + '\n');
console.log(`\n${shots.length} images in ${out} and docs/social.png, ${Math.round((Date.now() - started) / 1000)} s.`);
console.log(`Requests that reached the API stub: ${apiRequests.length ? apiRequests.join(', ') : 'none'}`);
