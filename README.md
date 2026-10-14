# VS Code Tools Bridge

A VS Code extension that gives Claude Code (the CLI) the tools of the VS Code window it works
in: live diagnostics, a workspace-wide rename, any VS Code command, the integrated browser,
the terminal and Copilot's semantic search. Claude sees them as an MCP server named
`vscode-tools`.

With Claude Code's VS Code extension, it also does two things:

- Text you select in the Markdown Editor shows up in Claude Code's selection chip, as a
  text editor's selection does.
- A file link in Claude Code's chat opens in the editor VS Code picks for that file, such as
  the Markdown Editor for `.md`. Claude Code itself always opens the text editor
  ([anthropics/claude-code#81482](https://github.com/anthropics/claude-code/issues/81482)).

It is not on the Marketplace. You install it from a clone of this repo.

## Tools

| MCP tool | What it does |
|----------|--------------|
| `get_diagnostics` | The Problems panel: type errors and lint findings. Give it `paths` to check particular files. A file that is not in a tab opens in a background preview tab, because TypeScript checks only open files. Filters: `minSeverity` (default `warning`) and `sources`, such as `["ts", "eslint"]`. |
| `rename_symbol` | Renames a symbol across the workspace with the language server, updates imports and references, and saves the changed files. |
| `execute_command` | Runs any VS Code command and returns its result as JSON. `{"$uri": "path"}`, `{"$position": {...}}` and `{"$range": {...}}` in the arguments become VS Code objects, so Claude can call `vscode.executeDefinitionProvider`, formatters, git commands and so on. |
| `list_commands` | Lists the command IDs `execute_command` may run, filtered by a substring. |
| `open_files` | Opens files in the editor for you to see. `path:line` jumps to the line. |
| `list_workspaces` | The window's workspace and folders, and where the bridge listens. |
| `visible_images` | The image files (PNG, JPEG, GIF, WebP) in front in each editor group. Claude reads the file to see the image. |
| `markdown_editor_selection` | The text selected in the Markdown Editor, with the file and line range. |
| `shared_browser_pages` | The integrated-browser pages you shared with **Share with Agent**, and the ones Claude opened, with their text. |

These tools come from VS Code and Copilot, and appear only while the window has them:

| MCP tool | Needs |
|----------|-------|
| `semantic_search`, `vscode_api_reference` | GitHub Copilot, signed in |
| `terminal_selection`, `terminal_last_command` | VS Code chat |
| `open_browser_page`, `navigate_page`, `read_page`, `screenshot_page`, `click_element`, `hover_element`, `drag_element`, `type_in_page`, `handle_dialog`, `run_playwright_code`, `list_browser_pages` | `workbench.browser.enableChatTools` on |

VS Code asks you before `open_browser_page`, `navigate_page` and `run_playwright_code` run. The
question is a dialog in the VS Code window, and Claude waits until you answer it. To skip
it, see step 5 of "Install by hand".

## Prompt hook

The optional prompt hook adds a note to each prompt you send. The note lists the browser
pages you shared, the image files in front in your editor groups, and the text selected in a
Markdown Editor that Claude Code's selection chip does not show. With nothing to report, it
adds nothing. It never blocks a prompt: it gives up after 900 ms.

## Install

You need VS Code 1.138 or later, Node 22.18 or later, and the `code` and `claude` commands
on your PATH.

With Claude Code, start `claude` in the clone and ask it to install the bridge. The
`install-vscode-tools-bridge` skill in this repo runs the setup script, then makes the
settings edits, and asks you before it changes each file.

Without it, run this in the clone:

```sh
npm run setup
```

The script installs the dependencies, builds the extension, installs it into VS Code and
registers `vscode-tools` with Claude Code for your user. It then prints what is left to do
by hand, with this clone's paths filled in: reload the VS Code windows, add the prompt hook,
and turn off the browser confirmations.

The bridge is on in every VS Code window. Start `claude` in the window's first workspace
folder, or a folder below it. `/mcp` lists `vscode-tools` as connected, and the **VS Code
Tools Bridge** output channel logs each call.

### Install by hand

1. Build and install the extension:

   ```sh
   npm ci
   npm run package
   code --install-extension vscode-tools-bridge-0.0.1.vsix --force
   ```

2. Register the MCP server, with the absolute path to `launcher.ts`:

   ```sh
   claude mcp add --scope user vscode-tools -- node /path/to/vscode-tools-bridge/launcher.ts
   ```

3. Reload each open VS Code window with **Developer: Reload Window**.
4. Optional: add the prompt hook to `~/.claude/settings.json`:

   ```json
   "hooks": {
     "UserPromptSubmit": [
       { "hooks": [{ "type": "command", "command": "node \"/path/to/vscode-tools-bridge/prompt-hook.ts\"", "timeout": 5 }] }
     ]
   }
   ```

5. Optional: skip the browser confirmations. Run **Preferences: Configure Runtime
   Arguments**, add this line to `argv.json`, and restart VS Code:

   ```jsonc
   "enable-proposed-api": ["local.vscode-tools-bridge"]
   ```

   Then set `"vscodeToolsBridge.autoApprove": true`.

### Update

After a `git pull`, run `npm run setup` again and reload the VS Code windows.

## Settings

| Setting | Default | Effect |
|---------|---------|--------|
| `vscodeToolsBridge.enabled` | `true` | Serves the window's tools. Set it to `false` in a workspace's settings to turn the bridge off there. |
| `vscodeToolsBridge.autoApprove` | `false` | Runs the browser tools without the confirmation dialog. Works only with the `argv.json` line from step 5. |
| `vscodeToolsBridge.executeCommand.allow` | `["*"]` | Command IDs `execute_command` may run. `*` matches any run of characters. |
| `vscodeToolsBridge.executeCommand.deny` | `[]` | Command IDs it must never run. Deny wins over allow. |

`execute_command` asks nothing, and by default it may run every command. To keep Claude from
closing the window, for example:

```jsonc
"vscodeToolsBridge.executeCommand.deny": ["workbench.action.quit", "workbench.action.closeWindow"]
```

A connection to the bridge must start with a secret token. The token is in a file in your user
profile, which other users cannot read.

## Limits

- Claude reaches the window whose first workspace folder holds the folder Claude started in.
- With two windows on the same first folder, Claude reaches the one that opened last.
- The bridge works only in a window with a local folder open.
- The tool list is the window's at the moment Claude asks for it.
- `get_diagnostics` waits 3 seconds on a clean file, unless Claude passes a lower `waitMs`.
- A chat link to a line or a heading, in a file that opens in the Markdown Editor or another
  custom editor, opens the file at the top.
- A Markdown Editor that was open before the bridge started reports no selection until you
  reopen it. A Markdown Editor that VS Code restores at startup can be one of them.
- With two Markdown Editors on the same file, the one opened last reports the selection.
- The Markdown Editor's selection reaches Claude even for a file that `.gitignore` or
  VS Code's exclude settings cover.
- At startup, an empty **VS Code Tools Bridge** tab opens and closes at once.
- The selection chip and the chat links can stop working after a Claude Code update. The
  output channel then says so, and the prompt hook, if installed, still reports the selection.

## Troubleshooting

| Symptom | Cause |
|---------|-------|
| `no VS Code window has <dir> or a parent of it as its first workspace folder` | The bridge is off in that window, or Claude started outside the window's first folder. The launcher waits 15 seconds for the window before it reports this. |
| `cannot reach the VS Code window … Is that window still open?` | The window closed or reloaded after Claude connected. Run `/mcp` and reconnect. |
| Browser or Copilot tools are missing | Copilot is not signed in, or `workbench.browser.enableChatTools` is off. |
| A browser tool call hangs | A confirmation dialog waits in the VS Code window. Answer it, or turn on auto-approve. |

## Development

```sh
npm run typecheck     # tsc, no output files
npm test              # offline checks, then an end-to-end run
```

VS Code and Node run the `.ts` files directly, with the types stripped, so nothing is built.
The code must stay erasable TypeScript: no enums, namespaces, parameter properties or JSX.

The end-to-end run (`test/run.ts`) downloads VS Code 1.138.0 into `.vscode-test/` and starts
it with its own settings and extensions. It calls every tool through `launcher.ts`, as Claude
Code does, and leaves your own VS Code and Claude Code settings alone. These variables change
it:

- `BRIDGE_TEST_VSIX=<path>` tests a built VSIX instead of the source.
- `BRIDGE_TEST_AUTO_APPROVE=1` turns on auto-approve and the `argv.json` line.
- `BRIDGE_TEST_NO_CLICK=1` leaves the confirmation dialogs for you to answer.
- `BRIDGE_TEST_WINDOW=offscreen|minimize|none` sets where the test window goes, on Windows
  only. The default, `offscreen`, keeps the page rendering, which `click_element` needs.

## License

MIT. See [LICENSE](LICENSE).
