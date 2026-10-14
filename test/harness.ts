// A small runner for the offline checks: `check` prints PASS or FAIL for one case, and `finish`
// ends the process with the exit code `npm test` needs.

let failed = 0;

export async function check(name: string, run: () => void | Promise<void>): Promise<void> {
	try {
		await run();
		console.log(`PASS  ${name}`);
	} catch (err) {
		failed++;
		console.log(`FAIL  ${name}  -- ${err instanceof Error ? err.message : String(err)}`);
	}
}

export function finish(): never {
	process.exit(failed ? 1 : 0);
}

export function skip(name: string, reason: string): void {
	console.log(`SKIP  ${name}  -- ${reason}`);
}
