// The files a module reaches through relative imports (static `from`, bare `import` and `import()`),
// for the offline checks that guard what an installed copy of the VSIX or the plugin needs.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** `entry` and every file it reaches through relative imports. A missing file throws. */
export function reachableFiles(entry: string): string[] {
	const seen = new Set<string>();
	const visit = (file: string): void => {
		if (seen.has(file)) {
			return;
		}
		seen.add(file);
		for (const match of readFileSync(file, 'utf8').matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.[^'"]*)['"]/g)) {
			visit(resolve(dirname(file), match[1]!));
		}
	};
	visit(resolve(entry));
	return [...seen];
}
