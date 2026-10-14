// Renders docs/icon.svg to icon.png, the 256 px file that package.json names as the extension's
// icon and that the README and the social preview show. VS Code takes a PNG, not an SVG. Edit the
// SVG, never the PNG: `npm run package` renders it again, and test/icon-check.ts fails when the
// committed PNG differs from the render.
//
//   npm run icon

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';

const root = join(import.meta.dirname, '..');

export const iconFile = join(root, 'icon.png');

export const renderIcon = (): Buffer =>
	new Resvg(readFileSync(join(root, 'docs', 'icon.svg')), { fitTo: { mode: 'width', value: 256 } }).render().asPng();

if (process.argv[1] && import.meta.filename === process.argv[1]) {
	writeFileSync(iconFile, renderIcon());
	console.log('Wrote icon.png');
}
