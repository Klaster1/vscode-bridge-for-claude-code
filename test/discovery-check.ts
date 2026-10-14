// Offline check of src/discovery.ts: the discovery folder's permissions and the lookup of a
// window's record, in a throwaway folder.
//
//   node test/discovery-check.ts

import { strict as assert } from 'node:assert';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoveryFile, ensureDiscoveryDir, findRecord, type DiscoveryRecord } from '../src/discovery.ts';
import { check, finish, skip } from './harness.ts';

const temp = mkdtempSync(join(tmpdir(), 'dc-'));
const discovery = join(temp, 'discovery');
process.env['VSCODE_TOOLS_BRIDGE_DIR'] = discovery;

if (process.platform === 'win32') {
	skip('ensureDiscoveryDir narrows a folder that exists with wider permissions', 'Windows has no permission bits');
} else {
	await check('ensureDiscoveryDir narrows a folder that exists with wider permissions', () => {
		mkdirSync(discovery);
		chmodSync(discovery, 0o755);
		ensureDiscoveryDir();
		assert.equal(statSync(discovery).mode & 0o777, 0o700);
	});
}

await check('findRecord reads a record, and finds an empty file as no record, not as a parent\'s', () => {
	ensureDiscoveryDir();
	const parent = join(temp, 'project');
	const child = join(parent, 'sub');
	const record = (folder: string): DiscoveryRecord => ({ pipe: 'p', token: 't', folder, pid: 1 });
	writeFileSync(discoveryFile(parent), JSON.stringify(record(parent)));
	assert.equal(findRecord(child)?.folder, parent, 'a subfolder finds the parent\'s window');
	writeFileSync(discoveryFile(child), ''); // As the window writes it.
	assert.ok(findRecord(child) === undefined, 'an empty file was read as a record');
	writeFileSync(discoveryFile(child), JSON.stringify(record(child)));
	assert.equal(findRecord(child)?.folder, child);
});

rmSync(temp, { recursive: true, force: true });
finish();
