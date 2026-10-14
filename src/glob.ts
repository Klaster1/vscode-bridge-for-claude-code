// The glob subset VS Code uses for editor associations and custom editor
// selectors: `*`, `**`, `?`, `[abc]`, `{a,b}`, matched without regard to case
// against the whole target.

function toRegExp(pattern: string): RegExp {
	let source = '';
	let braces = 0;
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i]!;
		if (c === '*') {
			if (pattern[i + 1] === '*') {
				i++;
				if (pattern[i + 1] === '/') {
					i++;
					source += '(?:.*/)?';
				} else {
					source += '.*';
				}
			} else {
				source += '[^/]*';
			}
		} else if (c === '?') {
			source += '[^/]';
		} else if (c === '{') {
			braces++;
			source += '(?:';
		} else if (c === '}' && braces > 0) {
			braces--;
			source += ')';
		} else if (c === ',' && braces > 0) {
			source += '|';
		} else if (c === '[' && pattern.indexOf(']', i + 2) > i) {
			const end = pattern.indexOf(']', i + 2);
			const set = pattern.slice(i + 1, end);
			source += `[${set.startsWith('!') ? '^' : ''}${set.replace(/^!/, '').replace(/[\\\]^]/g, '\\$&')}]`;
			i = end;
		} else {
			source += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		}
	}
	return new RegExp(`^${source}$`, 'i');
}

export function globMatches(pattern: string, target: string): boolean {
	try {
		return toRegExp(pattern).test(target);
	} catch {
		return false; // An unbalanced pattern matches nothing.
	}
}
