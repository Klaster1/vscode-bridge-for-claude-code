// Offline check of src/bridgeServer.ts, the part of the window that listens for the launcher
// and writes the discovery file, against a real pipe or socket in a throwaway folder.
//
//   node test/bridge-server-check.ts

import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect, Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridgeListener } from '../src/bridgeServer.ts';
import { discoveryFile, type DiscoveryRecord } from '../src/discovery.ts';
import { check, finish } from './harness.ts';

const temp = mkdtempSync(join(tmpdir(), 'bc-'));
const discovery = join(temp, 'missing', 'discovery'); // Not created: the listener must make it.
process.env['VSCODE_TOOLS_BRIDGE_DIR'] = discovery;

// Every server the listener creates, and whether the discovery folder existed when it began to listen.
const servers: Server[] = [];
const folderThere: boolean[] = [];
const prototype = Server.prototype as { listen: (...args: unknown[]) => unknown };
const listen = prototype.listen;
prototype.listen = function (this: Server, ...args: unknown[]) {
	servers.push(this);
	folderThere.push(existsSync(discovery));
	return listen.apply(this, args);
};

const handlers = { serve: () => undefined, warn: () => undefined, debug: () => undefined };
const workspace = (name: string) => join(temp, name);

await check('the discovery folder exists before the server listens', async () => {
	const bridge = createBridgeListener(handlers);
	const listening = await bridge.start(workspace('one'));
	assert.deepEqual(folderThere, [true], 'the folder was missing when the server began to listen');
	assert.equal(JSON.parse(readFileSync(discoveryFile(workspace('one')), 'utf8')).token, listening!.record.token);
	bridge.stop();
});

await check('a start that a newer start overtakes closes its server', async () => {
	servers.length = 0;
	const bridge = createBridgeListener(handlers);
	const [first, second] = [bridge.start(workspace('two')), bridge.start(workspace('two'))];
	const [overtaken, current] = await Promise.all([first, second]);
	assert.ok(overtaken === undefined, 'the overtaken start still returned a bridge');
	assert.ok(bridge.current === current, 'the newer start is not the current one');
	assert.equal(servers.length, 2);
	assert.deepEqual(servers.map(s => s.listening), [false, true], 'the overtaken server still listens');
	assert.equal((JSON.parse(readFileSync(discoveryFile(workspace('two')), 'utf8')) as DiscoveryRecord).token, current!.record.token);
	bridge.stop();
});

await check('a stop while a start is listening leaves no server and no discovery file', async () => {
	servers.length = 0;
	const bridge = createBridgeListener(handlers);
	const starting = bridge.start(workspace('three'));
	bridge.stop();
	assert.ok(await starting === undefined, 'the start returned a bridge after the stop');
	assert.ok(bridge.current === undefined, 'a bridge is current after the stop');
	assert.deepEqual(servers.map(s => s.listening), [false]);
	assert.equal(existsSync(discoveryFile(workspace('three'))), false);
});

await check('a connection that sends no token is closed, and one that sent it may idle', async () => {
	const served: Socket[] = [];
	const bridge = createBridgeListener({ ...handlers, serve: (_input, socket) => void served.push(socket) });
	const { record } = (await bridge.start(workspace('four')))!;
	const closedAfter = (socket: Socket) => new Promise<number>(resolve => {
		const began = Date.now();
		setTimeout(() => resolve(Infinity), 8_000).unref();
		socket.on('close', () => resolve(Date.now() - began));
		socket.on('error', () => undefined);
	});
	const silent = connect(record.pipe);
	const partial = connect(record.pipe, () => partial.write('half a token')); // No newline.
	const trusted = connect(record.pipe, () => trusted.write(`${record.token}\n`));
	let trustedClosed = false;
	trusted.on('close', () => { trustedClosed = true; });
	const [silentMs, partialMs] = await Promise.all([closedAfter(silent), closedAfter(partial)]);
	assert.ok(silentMs < 8_000 && partialMs < 8_000, `closed after ${silentMs} and ${partialMs} ms`);
	await new Promise(done => setTimeout(done, 500)); // The connection that sent the token began at the same time.
	assert.ok(!trustedClosed, 'the connection that sent the token was closed');
	assert.equal(served.length, 1);
	trusted.destroy();
	bridge.stop();
});

rmSync(temp, { recursive: true, force: true });
finish();
