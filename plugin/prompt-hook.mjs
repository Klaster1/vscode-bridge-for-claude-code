// The UserPromptSubmit hook. A Node too old to strip TypeScript types adds no note and no error,
// so the hook never fails a prompt.
if (process.features.typescript) {
	await import('./scripts/prompt-hook.ts');
}
