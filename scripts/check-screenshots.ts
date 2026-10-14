// Fails when the committed screenshots are stale: their inputs changed since the last
// `npm run screenshots`, or an image the README or the last run names is missing. Offline and
// tokenless, for CI, which never generates images.
//
//   node scripts/check-screenshots.ts

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashInputs, recordFile, type InputRecord } from './screenshot-inputs.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const rerun = 'Run `npm run screenshots` locally and commit the images.';
const problems: string[] = [];

const record = existsSync(join(root, recordFile)) ? JSON.parse(readFileSync(join(root, recordFile), 'utf8')) as InputRecord : undefined;
if (!record) {
	problems.push(`${recordFile} is missing.`);
} else {
	const now = hashInputs(root);
	if (now.hash !== record.hash) {
		const paths = [...new Set([...Object.keys(now.files), ...Object.keys(record.files)])].sort();
		const changed = paths.filter(p => now.files[p] !== record.files[p])
			.map(p => `  ${p} (${!record.files[p] ? 'added' : !now.files[p] ? 'removed' : 'changed'})`);
		problems.push(`The screenshots are stale: these inputs differ from the last run:\n${changed.join('\n')}`);
	}
}

const readme = readFileSync(join(root, 'README.md'), 'utf8');
const referenced = [...readme.matchAll(/\(\.?\/?(docs\/[^)\s"']+\.png)/g)].map(m => m[1]!);
for (const image of new Set([...referenced, ...record?.images ?? []])) {
	if (!existsSync(join(root, image))) {
		problems.push(`${image} is missing${referenced.includes(image) ? ', and README.md shows it' : ''}.`);
	}
}

if (problems.length) {
	console.error(`${problems.join('\n')}\n${rerun}`);
	process.exit(1);
}
console.log(`Screenshots are up to date (inputs ${record!.hash.slice(0, 12)}).`);
