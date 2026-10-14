# VS Code Tools Bridge

Gives Claude Code (the CLI) the tools a VS Code window already has: live
diagnostics from the language servers, a real workspace rename, any VS Code
command, the integrated browser, the terminal, and Copilot's semantic search.
Claude calls them as an ordinary MCP server named `vscode-tools`, and each call
runs inside the VS Code window whose folder Claude is working in.

It has three parts:

- **The extension** runs in each VS Code window. It serves that window's tools
  over MCP on a private named pipe (a Unix socket on macOS and Linux).
- **`launcher.ts`** is the stdio MCP server that Claude Code starts. It finds the
  window for its working directory and passes bytes both ways.
- **`prompt-hook.ts`** is an optional `UserPromptSubmit` hook. Before each
  prompt, it tells Claude which integrated-browser pages you have shared with it,
  which image files you have on screen and which text you have selected in the
  Markdown Editor.

Nothing is built. VS Code's extension host and Node 22.18+ run the `.ts` files
directly by stripping their types.

## Tools

| MCP tool | What it does |
|----------|--------------|
| `get_diagnostics` | Problems-panel diagnostics (type errors, lint findings). Give it `paths` to check particular files: each one not already in a tab opens in a background preview tab, because TypeScript only checks open files, and the tool waits for the language server to report. Filters: `minSeverity` (default `warning`), `sources` (for example `["ts", "eslint"]`). |
| `rename_symbol` | Renames a symbol across the workspace with the language server's rename provider, updating imports and references, then saves the changed files. Find the symbol by line plus either its column or its name. |
| `execute_command` | Runs any VS Code command and returns its result as JSON. Arguments can hold `{"$uri": "path"}`, `{"$position": {...}}` and `{"$range": {...}}`, which become real VS Code objects, so it can call `vscode.executeDefinitionProvider`, `vscode.executeReferenceProvider`, formatters, git commands and so on. Limited by the allow and deny settings below. |
| `list_commands` | Lists the command IDs that `execute_command` may run, filtered by a substring. |
| `open_files` | Opens files in the editor so you can see them. Add `:line` to a path to jump to that line; `background: true` keeps focus where it is. |
| `list_workspaces` | The window's workspace name, workspace file and folders, plus the bridge's pipe and discovery file, for debugging. |
| `visible_images` | Image files (PNG, JPEG, GIF, WebP) in the front tab of each editor group, with their paths. Claude reads a path with its Read tool to see the image. |
| `markdown_editor_selection` | The text selected in the rich Markdown Editor, in the front tab of each editor group that shows one: the file path, the 1-based line range and the selected text (`maxChars` caps it, default 4000). With nothing selected, the cursor line. `selectedOnly: true` skips editors with no selected text, and `skipDelivered: true` skips those that Claude Code's selection chip already shows. See [Markdown Editor selection](#markdown-editor-selection). |
| `shared_browser_pages` | Integrated-browser pages shared with the agent: the ones you shared with the page toolbar's **Share with Agent** button, and any Claude opened. Returns each page's ID, title, URL and, unless `snapshot` is false, its text snapshot. |

Tools forwarded from VS Code and Copilot keep their own schemas and
descriptions. Each one appears only while VS Code or Copilot registers it in
that window:

| MCP tool | VS Code tool | Needs |
|----------|--------------|-------|
| `semantic_search` | `copilot_searchCodebase` | GitHub Copilot |
| `vscode_api_reference` | `copilot_getVSCodeAPI` | GitHub Copilot |
| `terminal_selection`, `terminal_last_command` | same names | VS Code chat |
| `open_browser_page`, `navigate_page`, `read_page`, `screenshot_page`, `click_element`, `hover_element`, `drag_element`, `type_in_page`, `handle_dialog`, `run_playwright_code`, `list_browser_pages` | same names | `workbench.browser.enableChatTools` on |

Copilot's tools often return prompt-tsx trees rather than text. The bridge
renders them to plain text, and returns screenshots as MCP images.

### Browser confirmations

VS Code asks before three browser tools run: `open_browser_page`,
`navigate_page` and `run_playwright_code`. Called from outside chat, the
question is a modal dialog in the window, and the call waits until you answer
it. To skip the dialog, turn on `vscodeToolsBridge.autoApprove` and start VS Code
with the extension's proposed API enabled (see [Setup](#setup), step 4). Without
the proposed API, VS Code ignores the approval and the dialog still shows.

### Markdown Editor selection

VS Code has no API for the selection in its rich Markdown Editor (the built-in
`vscode.markdown.editor` custom editor), and Claude Code's own IDE context
follows only the active text editor. So the extension patches the Markdown
extension's webview at runtime. While `vscodeToolsBridge.enabled` is on, it
wraps the `html` setter that all webviews in the extension host share. When the
Markdown Editor sets its page, the wrapper inserts one script. The script sends
the editor's selection offsets to the extension and reads nothing else from the
page. The extension turns the offsets into a line range and text from the open
document, so unsaved edits count.

The extension also wraps `postMessage` on the same shared prototype. That shows
it which webviews are Claude Code's chat webviews: the ones that receive its
`from-extension` messages. When a Markdown Editor's selection changes, the
extension posts a `selection_changed` message to them, in the format Claude Code
uses for a text editor's selection. Claude Code then shows its own selection
chip and adds the selection to your prompt as it does for a text editor. The
eye button on the chip works as usual. A Markdown Editor that comes to the front
sends its selection again. With `claudeCode.attachOpenFile` off, an empty
selection clears the chip, as in a text editor.

Notes:

- The chip depends on Claude Code's internal message format, and it can break
  when Claude Code updates. The extension then logs it once, and the prompt hook
  note carries the selection instead.
- The bridge finds a Claude Code webview when that webview next receives a
  message from Claude Code, so a chat panel that is open at startup is found at
  its first message.
- Unlike Claude Code for a text editor, the extension does not check the file
  against `.gitignore` and the exclude settings before it sends the text.
- At startup, the extension opens a webview panel in the active editor group and
  closes it at once, to reach the shared setter. It creates no editor group.
- The patch is removed when the bridge stops or the setting turns off. A Markdown
  Editor that was open at that time is read again only after you reopen it.
- A Markdown Editor that VS Code restores at startup can open before the bridge
  activates. It then has no script, and its selection is read after you reopen it.
- If the Markdown extension's page changes so that the patch does not fit, the
  extension logs it once in the **VS Code Tools Bridge** output channel and
  reads no selection. The Markdown Editor itself keeps working.
- Two editors that show the same file report the selection of the one that
  opened last.

### Chat links

A file link in Claude Code's chat opens in the editor that your
`workbench.editorAssociations` setting or a custom editor chooses, such as the
Markdown Editor for `.md` files ([anthropics/claude-code#81482](https://github.com/anthropics/claude-code/issues/81482)).
Claude Code opens a link with `window.showTextDocument`, which always uses the
text editor. The extension wraps that function on the `vscode` API object that
Claude Code holds. For a file that should open in another editor, the wrapper
rejects the call, and Claude Code then falls back to its `vscode.open` command,
which follows your associations. A file opens in another editor when an
association other than `default` matches it (the longest matching pattern wins),
or when an installed extension contributes a custom editor with priority
`default` for it, such as a PDF viewer. All other calls pass through unchanged.

- A link with a line range, a search text or a heading opens the file without
  scrolling to it, because Claude Code reveals the position only in a text
  editor.
- This depends on Claude Code's internals, and it can break when Claude Code
  updates. If the extension cannot find Claude Code or a replaceable function,
  it logs that once in the **VS Code Tools Bridge** output channel and links
  open as before.
- Like the Markdown Editor patch, it applies only while `vscodeToolsBridge.enabled`
  is on and a local folder is open.

### Shared pages, images and selections in every prompt

With the prompt hook installed, a prompt sent while you have a page shared
reaches Claude with a note listing the shared pages' IDs, titles and URLs. Claude
then knows what "this page" means without being told to look. A prompt sent
while an image file is in front in an editor group gets a note with the image's
path, which Claude reads to see it. Claude Code's own IDE context follows only
the active text editor, and an image opens in the image preview. A prompt sent
while text is selected in a Markdown Editor that is in front in an editor group
gets a note with the file, the line range and the selected text, unless Claude
Code's selection chip already shows that selection. The hook adds
nothing when there is nothing to report or the bridge is off. It gives up after 900 ms and
never fails a prompt.

## Setup

Needs VS Code 1.138 or later, and Node 22.18 or later for the launcher and hook.

1. **Build and install the extension.**

   ```sh
   cd vscode-tools-bridge
   npm install
   npm run package          # writes vscode-tools-bridge-<version>.vsix
   code --install-extension vscode-tools-bridge-0.0.1.vsix
   ```

2. **Turn the bridge on** in the workspace settings (or `settings.json`) of each
   workspace that should serve Claude. It is off by default:

   ```jsonc
   "vscodeToolsBridge.enabled": true
   ```

3. **Register the MCP server with Claude Code**, with an absolute path to the
   launcher:

   ```sh
   claude mcp add --scope user vscode-tools -- node /path/to/vscode-tools-bridge/launcher.ts
   ```

4. **Optional: skip the browser confirmations.** Open **Preferences: Configure
   Runtime Arguments** (`argv.json`), add the line below, restart VS Code, then set
   `"vscodeToolsBridge.autoApprove": true`.

   ```jsonc
   "enable-proposed-api": ["local.vscode-tools-bridge"]
   ```

5. **Optional: install the prompt hook** in a Claude Code settings file:

   ```json
   "hooks": {
     "UserPromptSubmit": [
       { "hooks": [{ "type": "command", "command": "node /path/to/vscode-tools-bridge/prompt-hook.ts", "timeout": 5 }] }
     ]
   }
   ```

Start `claude` in the window's first workspace folder or any folder below it.
`/mcp` should list `vscode-tools` as connected.

## Settings

| Setting | Default | Effect |
|---------|---------|--------|
| `vscodeToolsBridge.enabled` | `false` | Serve this window's tools. |
| `vscodeToolsBridge.autoApprove` | `false` | Run the browser tools that ask for confirmation without the dialog. Needs the proposed API (Setup, step 4). |
| `vscodeToolsBridge.executeCommand.allow` | `["*"]` | Command IDs `execute_command` may run. `*` matches any run of characters. |
| `vscodeToolsBridge.executeCommand.deny` | `[]` | Command IDs it must never run. Deny wins over allow. |

`execute_command` shows no confirmation, and by default it may run every
command. To keep Claude from closing the window, for example:

```jsonc
"vscodeToolsBridge.executeCommand.deny": ["workbench.action.quit", "workbench.action.closeWindow"]
```

## How Claude finds the window

Each window registers under its **first** workspace folder. When the bridge
starts, it writes a discovery file named after a hash of that folder, holding the
pipe name and a random token:

- Windows: `%LOCALAPPDATA%\vscode-tools-bridge\`
- macOS and Linux: `~/.cache/vscode-tools-bridge/`

The launcher starts at its working directory and walks up until it finds a
discovery file, so a Claude session started in a subfolder still finds its
window. Symlinks and junctions are followed, and Windows paths are compared
without regard to case.

Things worth knowing:

- **One window per folder.** If two windows share a first folder, the one that
  started last takes over the discovery file and Claude reaches that one.
- **Changing folders.** Adding or removing workspace folders, or toggling
  `enabled`, restarts the bridge under the new first folder.
- **Security.** The discovery file sits in your user profile, which other users
  cannot read. A connection must send the token as its first line or it is
  closed.
- **Logs.** The **VS Code Tools Bridge** output channel logs each call and how
  long it took, plus any rejected connection.

## Troubleshooting

| Symptom | Cause |
|---------|-------|
| `no VS Code window has <dir> or a parent of it as its first workspace folder` | The bridge is off in that window, or Claude started outside the window's first folder. The launcher waits 15 s for the window before it reports this. Check the output channel. |
| `cannot reach the VS Code window … Is that window still open?` | The window closed or reloaded after Claude connected. Run `/mcp` and reconnect. |
| Browser or Copilot tools missing | Copilot is not signed in, or `workbench.browser.enableChatTools` is off. The tool list reflects the window at the moment Claude asks for it. |
| A browser call hangs | A confirmation dialog is waiting in the VS Code window. Answer it, or set up auto-approve. |
| `get_diagnostics` on a clean file takes 3 s | It waits the full `waitMs` for errors that never come. Lower `waitMs` if you only need quick checks. |

## Development

```sh
npm run typecheck     # tsc, no output files
npm test              # offline render check, then an end-to-end run
```

The end-to-end run (`test/run.ts`) downloads VS Code 1.138.0 into
`.vscode-test/`, starts it with its own user data, extensions and discovery
folders, and calls every tool through `launcher.ts`, the way Claude Code does.
It never touches your own VS Code or Claude settings. Environment variables:

- `BRIDGE_TEST_VSIX=<path>` tests a packaged VSIX instead of the source.
- `BRIDGE_TEST_AUTO_APPROVE=1` turns on auto-approve and the proposed API.
- `BRIDGE_TEST_NO_CLICK=1` leaves confirmation dialogs for a person to answer.
- `BRIDGE_TEST_WINDOW=offscreen|minimize|none` sets where the test window goes
  (Windows only). The default, `offscreen`, keeps the page rendering, which
  `click_element` needs.

The code must stay erasable TypeScript, meaning no enums, namespaces,
parameter properties or JSX, because nothing compiles it.
