// Offline check that icon.png is the render of docs/icon.svg, so the manifest, the README and the
// social preview show the icon that the SVG draws.
//
//   node test/icon-check.ts

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { iconFile, renderIcon } from '../scripts/generate-icon.ts';
import { check, finish } from './harness.ts';

await check('icon.png is the render of docs/icon.svg: run npm run icon after an edit of the SVG', () => {
	assert.ok(readFileSync(iconFile).equals(renderIcon()));
});

finish();
