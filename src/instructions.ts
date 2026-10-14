// The MCP server instructions. Claude Code adds them to the system prompt of every session, so
// they say when the tools fit and stay short. Claude Code cuts them at 4096 characters.

export const serverInstructions = `Tools of the VS Code window the user works in. Use them without being asked.

Before you ask what "this", "this page" or "this image" means, read the notes on the prompt about shared browser pages, open images and the Markdown Editor selection, or call shared_browser_pages, visible_images or markdown_editor_selection.

Integrated browser:
- Open a page with open_browser_page. To check how it looks, take a screenshot with screenshot_page.
- To set the viewport size, call run_playwright_code with \`await page.setViewportSize({ width: 1280, height: 800 })\`.
- A page that is not on screen paints at 1024×768 only, so a larger viewport comes out cut off.
- To save screenshots to files or capture at 2x, use the vscode-bridge:browser-screenshots skill. To record a video, use vscode-bridge:browser-recordings.

VS Code operations run through execute_command, with 0-based positions. Where a language server knows the answer, use it over a text search:
- Go to definition: \`vscode.executeDefinitionProvider\` with \`[{"$uri": "src/a.ts"}, {"$position": {"line": 9, "character": 4}}]\`.
- Find references: \`vscode.executeReferenceProvider\` with the same arguments.
- Show the user a diff: \`vscode.diff\` with \`[{"$uri": "<left>"}, {"$uri": "<right>"}, "<title>"]\`.
Find other command IDs with list_commands, such as "git." for Git or "comment" for review comments. The vscode-bridge:vscode-commands skill covers more: implementations, symbol search, a file's git change and a review comment box.`;
