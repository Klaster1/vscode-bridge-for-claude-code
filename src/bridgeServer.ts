// The window's listening side, which needs no VS Code API: the pipe or socket the window
// serves on and the discovery file that names it. extension.ts adds the MCP server on top.
// Imports nothing from 'vscode', so test/bridge-server-check.ts can run it in plain Node.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { discoveryDir, discoveryFile, ensureDiscoveryDir, folderHash, type DiscoveryRecord } from './discovery.ts';

export interface Listening {
	server: NetServer;
	file: string;
	record: DiscoveryRecord;
}

export interface BridgeHandlers {
	/** Called with the rest of a connection's stream once its first line was the token. */
	serve(input: PassThrough, socket: Socket): void;
	warn(message: string): void;
	debug(message: string): void;
}

export function createBridgeListener(handlers: BridgeHandlers) {
	let current: Listening | undefined;

	async function start(folder: string): Promise<Listening> {
		const hash = folderHash(folder);
		const record: DiscoveryRecord = {
			pipe: process.platform === 'win32'
				? `\\\\.\\pipe\\vscode-tools-bridge-${hash}-${randomBytes(8).toString('hex')}`
				: join(discoveryDir(), `${hash}-${randomBytes(8).toString('hex')}.sock`),
			token: randomBytes(32).toString('hex'),
			folder,
			pid: process.pid,
		};
		ensureDiscoveryDir(); // A socket file needs its folder before the server listens.
		const server = createServer(socket => acceptConnection(socket, record.token, handlers));
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(record.pipe, resolve);
		});
		const file = discoveryFile(folder);
		// A second window on the same first folder takes over the file; the
		// earlier window keeps its pipe but is no longer found.
		writeFileSync(file, JSON.stringify(record, null, 2), { mode: 0o600 });
		current = { server, file, record };
		return current;
	}

	function stop(): void {
		if (!current) {
			return;
		}
		const { server, file, record } = current;
		current = undefined;
		server.close();
		try {
			// Remove the file only if another window has not taken it over.
			if ((JSON.parse(readFileSync(file, 'utf8')) as DiscoveryRecord).token === record.token) {
				rmSync(file);
			}
		} catch {
			// Already gone.
		}
	}

	return { start, stop, get current() { return current; } };
}

/**
 * The first line on a connection must be the token from the discovery file;
 * anything else closes the connection. The rest of the stream is MCP
 * (newline-delimited JSON-RPC), which `handlers.serve` answers.
 */
function acceptConnection(socket: Socket, token: string, handlers: BridgeHandlers): void {
	let buffered = Buffer.alloc(0);
	const expected = Buffer.from(token);
	const onData = (chunk: Buffer) => {
		buffered = Buffer.concat([buffered, chunk]);
		const newline = buffered.indexOf(0x0a);
		if (newline < 0) {
			if (buffered.length > 256) {
				socket.destroy();
			}
			return;
		}
		socket.off('data', onData);
		const offered = buffered.subarray(0, newline);
		if (offered.length !== expected.length || !timingSafeEqual(offered, expected)) {
			handlers.warn('Rejected a connection with a wrong token.');
			socket.destroy();
			return;
		}
		const input = new PassThrough();
		input.write(buffered.subarray(newline + 1));
		socket.pipe(input);
		handlers.serve(input, socket);
	};
	socket.on('data', onData);
	socket.on('error', err => handlers.debug(`Connection error: ${err.message}`));
}
