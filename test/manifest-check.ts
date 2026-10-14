// Offline check of package.json: the package script passes vsce the flags this extension needs.
//
//   node test/manifest-check.ts

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, finish } from './harness.ts';

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { activationEvents: string[]; scripts: Record<string, string> };

await check('the package script allows the * activation event, so vsce does not stop to ask in a terminal', () => {
	assert.ok(manifest.activationEvents.includes('*'));
	assert.match(manifest.scripts['package'] ?? '', /--allow-star-activation/);
});

finish();
