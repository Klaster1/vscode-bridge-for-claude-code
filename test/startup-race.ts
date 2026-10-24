// End-to-end check of the Markdown Editor patch's start-up race, on Windows only, in an isolated VS Code
// (the setup of test/run.ts). A Markdown Editor tab that VS Code restores activates the Markdown extension
// at window start. The bridge must be active before that, or the Markdown extension registers its editor
// unseen and no Markdown Editor selection is read in the window. The test opens a Markdown file, closes
// the window the way VS Code does when it quits, starts it again with the tab restored, and reads the
// bridge's log.
//
//   node test/startup-race.ts

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { check, finish, skip } from './harness.ts';

if (process.platform !== 'win32') {
	skip('Markdown Editor patch is in place when a restored tab starts the Markdown extension', 'test/window-helper.ps1 needs Windows');
	finish();
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const run = join(root, '.vscode-test', 'startup');
const workspace = join(run, 'workspace');
const userData = join(run, 'user-data');
rmSync(run, { recursive: true, force: true });
mkdirSync(join(userData, 'User'), { recursive: true });
mkdirSync(join(run, 'extensions'), { recursive: true });
mkdirSync(join(run, 'discovery'), { recursive: true });
mkdirSync(workspace, { recursive: true });
writeFileSync(join(workspace, 'notes.md'), '# Notes\n\nSome text to select.\n');
writeFileSync(join(userData, 'User', 'settings.json'), JSON.stringify({
	'security.workspace.trust.enabled': false,
	'update.mode': 'none',
	'telemetry.telemetryLevel': 'off',
	'workbench.startupEditor': 'none',
	'workbench.editorAssociations': { '*.md': 'vscode.markdown.editor' },
}, null, 2));

const exe = await downloadAndUnzipVSCode({ version: '1.143.1', cachePath: join(root, '.vscode-test') });
// As in test/run.ts: variables from a VS Code parent would let the instance reach the user's running one.
const env: NodeJS.ProcessEnv = { VSCODE_BRIDGE_DIR: join(run, 'discovery') };
for (const [k, v] of Object.entries(process.env)) {
	if (!/^(VSCODE_|ELECTRON_)/.test(k)) {
		env[k] = v;
	}
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const port = await new Promise<number>(resolve => {
	const probe = createServer().listen(0, '127.0.0.1', () => {
		const { port } = probe.address() as AddressInfo;
		probe.close(() => resolve(port));
	});
});

/** The newest file with this name under the logs folder; each start has its own logs folder. */
function newestLog(name: string): string {
	const found: { file: string; time: number }[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(path);
			} else if (entry.name === name) {
				found.push({ file: path, time: statSync(path).mtimeMs });
			}
		}
	};
	if (existsSync(join(userData, 'logs'))) {
		walk(join(userData, 'logs'));
	}
	return found.sort((a, b) => b.time - a.time)[0]?.file ?? '';
}
const bridgeLog = (): string => {
	const file = newestLog('VS Code Bridge for Claude Code.log');
	return file ? readFileSync(file, 'utf8') : '';
};

/** Starts the window with the bridge from source; `files` open in it. Its window stays off the screen. */
function start(files: string[]) {
	const code = spawn(exe, [
		workspace, ...files,
		`--extensionDevelopmentPath=${root}`,
		`--user-data-dir=${userData}`,
		`--extensions-dir=${join(run, 'extensions')}`,
		'--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--new-window',
		`--remote-debugging-port=${port}`,
	], { env, stdio: 'ignore' });
	const helper = spawn('powershell.exe', [
		'-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'test', 'window-helper.ps1'),
		'-ProcessId', String(code.pid), '-LogFile', join(run, 'window-helper.log'), '-Hide', 'offscreen', '-Size', '1024x768', '-NoClick',
	], { stdio: 'ignore' });
	const exited = new Promise<void>(resolve => code.once('exit', () => resolve()));
	return { code, exited, stop: () => { helper.kill(); spawnSync('taskkill', ['/PID', String(code.pid), '/T', '/F']); } };
}
async function until(what: string, done: () => boolean): Promise<void> {
	for (let i = 0; i < 240 && !done(); i++) {
		await sleep(500);
	}
	if (!done()) {
		throw new Error(`${what} did not happen in 120 s`);
	}
}
/** Asks the window to quit through the browser protocol, which runs VS Code's shutdown and keeps its open editors. */
async function quit(): Promise<void> {
	const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as { webSocketDebuggerUrl: string };
	const socket = new WebSocket(webSocketDebuggerUrl);
	await new Promise(resolve => socket.addEventListener('open', resolve));
	socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
}

await check('the Markdown Editor patch is in place when a restored tab starts the Markdown extension', async () => {
	const first = start([join(workspace, 'notes.md')]);
	try {
		await until('the bridge starting', () => /Listening on/.test(bridgeLog()));
		await sleep(3000); // Lets the window settle before it quits.
		await quit();
		await Promise.race([first.exited, sleep(60_000)]);
	} finally {
		first.stop();
	}
	await sleep(2000);
	const second = start([]); // The tab comes back from the first window's saved state.
	try {
		await until('the bridge starting again', () => /Listening on/.test(bridgeLog()));
		await sleep(3000);
		const exthostLog = readFileSync(newestLog('exthost.log'), 'utf8');
		if (!/markdown-language-features, startup: false, activationEvent: 'onCustomEditor:vscode\.markdown\.editor'/.test(exthostLog)) {
			throw new Error('the Markdown Editor tab did not come back, so the test cannot tell');
		}
		const log = bridgeLog();
		if (/Markdown Editor selection:/.test(log)) {
			throw new Error(log.split('\n').find(line => /Markdown Editor selection:/.test(line)));
		}
	} finally {
		second.stop();
	}
});

finish();
