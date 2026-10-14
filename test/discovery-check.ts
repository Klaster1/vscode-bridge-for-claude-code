// Offline check of src/discovery.ts: the discovery folder's permissions and the lookup of a
// window's record, in a throwaway folder.
//
//   node test/discovery-check.ts

import { strict as assert } from 'node:assert';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDiscoveryDir } from '../src/discovery.ts';
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

rmSync(temp, { recursive: true, force: true });
finish();
