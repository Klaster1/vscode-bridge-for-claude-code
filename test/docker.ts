// Runs `npm test` in the Linux container of test/Dockerfile, the way CI does, on any machine with
// Docker. The image holds the git-tracked files of the working tree, with their uncommitted changes,
// and its own node_modules; nothing from the host's node_modules or .vscode-test goes in.
// After the run, the logs and the screenshot of a failed run are in .vscode-test/docker/.
//
//   node test/docker.ts
//
// BRIDGE_TEST_AUTO_APPROVE, BRIDGE_TEST_NO_CLICK, BRIDGE_TEST_TRACE and BRIDGE_TEST_VSIX reach
// test/run.ts in the container, as the header of test/run.ts describes.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const image = 'vscode-bridge-for-claude-code-test';
const repo = '/home/node/repo'; // The WORKDIR of test/Dockerfile.
const out = join(root, '.vscode-test', 'docker');

const docker = (args: string[], input?: Buffer) => {
	const result = spawnSync('docker', args, { stdio: [input ? 'pipe' : 'inherit', 'inherit', 'inherit'], input });
	if (result.error) {
		throw result.error;
	}
	return result.status ?? 1;
};

// The build context is a tar of the tracked files, so an untracked file stays out, as it does in CI.
const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).stdout.split('\0').filter(f => f && existsSync(join(root, f)));
const context = spawnSync('tar', ['-c', '-f', '-', '--null', '-T', '-'], { cwd: root, input: tracked.join('\0'), maxBuffer: 1 << 30 });
if (context.status !== 0) {
	throw new Error(`tar failed: ${String(context.stderr)}`);
}
if (docker(['build', '--tag', image, '--file', 'test/Dockerfile', '-'], context.stdout) !== 0) {
	process.exit(1);
}

const env = ['BRIDGE_TEST_AUTO_APPROVE', 'BRIDGE_TEST_NO_CLICK', 'BRIDGE_TEST_TRACE'].filter(name => process.env[name]).flatMap(name => ['--env', name]);
const vsix = process.env['BRIDGE_TEST_VSIX'];
const vsixMount = vsix ? ['--volume', `${resolve(vsix)}:/tmp/${basename(vsix)}:ro`, '--env', `BRIDGE_TEST_VSIX=/tmp/${basename(vsix)}`] : [];
const container = `${image}-${randomBytes(4).toString('hex')}`;
let status = 1;
try {
	status = docker([
		'run', '--name', container, '--init',
		'--shm-size=1g', // Chromium keeps shared memory in /dev/shm, which is 64 MB by default, and its pages crash when it runs out.
		'--volume', `${image}-cache:${repo}/.vscode-test`, // Keeps the VS Code download between runs.
		...env, ...vsixMount,
		image,
	]);
} finally {
	rmSync(out, { recursive: true, force: true });
	mkdirSync(out, { recursive: true });
	for (const path of ['run/user-data/logs', 'run/vscode.log', 'run/dialogs.log', 'run/screen.png']) {
		spawnSync('docker', ['cp', `${container}:${repo}/.vscode-test/${path}`, join(out, basename(path))], { stdio: 'ignore' });
	}
	spawnSync('docker', ['rm', '--force', container], { stdio: 'ignore' });
}
console.log(`Logs: ${out}`);
process.exit(status);
