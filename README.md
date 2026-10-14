# VS Code Tools Bridge

A VS Code extension that gives Claude Code (the CLI) the tools and the screen of the VS Code window it works in.

## Claude uses VS Code's tools

Claude gets these tools as the `vscode-tools` MCP server. Ask for the result, such as "check
this file for type errors", and Claude picks the tool.

| Tool | What it does |
|------|--------------|
| `get_diagnostics` | Type errors and lint findings from the Problems panel, for the workspace or for given files. |
| `rename_symbol` | Renames a symbol across the workspace, with its imports and references, and saves the files. |
| `execute_command` | Runs any VS Code command, such as go to definition, find references, a formatter or a git command. |
| `list_commands` | Lists the commands `execute_command` may run. |
| `open_files` | Opens files in the editor, at a given line. |
| `list_workspaces` | The window's workspace folders. |
| `semantic_search`, `vscode_api_reference` | Copilot's codebase search and VS Code API reference. Needs GitHub Copilot, signed in. |
| `terminal_selection`, `terminal_last_command` | The text selected in the terminal, and the terminal's last command. Needs VS Code chat. |
| `open_browser_page`, `read_page`, `screenshot_page`, `click_element` and other browser tools | Open, read and screenshot pages in VS Code's integrated browser, click, hover, drag and type there, and run Playwright code. Needs `workbench.browser.enableChatTools` on. |

To show Claude a page you have open in the integrated browser, press **Share with Agent** in
the page toolbar. With the prompt hook from the install steps, each prompt tells Claude which
pages you share, so "this page" needs no more explanation.

Limits:

- `execute_command` asks you nothing before it runs a command.
- VS Code asks you before Claude opens a page, navigates or runs Playwright code. Claude waits
  until you answer the dialog in the VS Code window.
- `get_diagnostics` opens each file it checks in a background preview tab, because TypeScript checks only open files.
- `get_diagnostics` waits 3 seconds on a file with no problems.
- Claude sees the Copilot and terminal tools only while the window has them.

Settings:

| Setting | Default | Effect |
|---------|---------|--------|
| `vscodeToolsBridge.executeCommand.allow` | `["*"]` | Command IDs `execute_command` may run. `*` matches any run of characters. |
| `vscodeToolsBridge.executeCommand.deny` | `[]` | Command IDs it must never run. Deny wins over allow. |
| `vscodeToolsBridge.autoApprove` | `false` | Skips the browser dialog. |

To keep Claude from closing the window, for example:

```jsonc
"vscodeToolsBridge.executeCommand.deny": ["workbench.action.quit", "workbench.action.closeWindow"]
```

`autoApprove` works only after you run **Preferences: Configure Runtime Arguments**, add this
line to `argv.json` and restart VS Code:

```jsonc
"enable-proposed-api": ["local.vscode-tools-bridge"]
```

## Claude sees the images you have open

Open an image file (PNG, JPEG, GIF or WebP) in VS Code, and Claude can look at it. With the
prompt hook from the install steps, each prompt tells Claude which images you have open, so
"this screenshot" needs no path.

Limits:

- Claude sees only the image in the front tab of each editor group.

## Claude sees your Markdown Editor selection

Select text in VS Code's Markdown Editor. Claude Code's selection chip shows it, and Claude
gets it with your prompt, as it does for a text editor. This needs Claude Code's VS Code
extension.

Limits:

- A Markdown Editor that was open before the bridge started, or before you turned on
  `vscodeToolsBridge.markdownEditor.selection`, shows no selection until you reopen it. VS
  Code can restore such editors at startup.
- With two Markdown Editors on the same file, the one opened last counts.
- Claude gets the selection even in a file that `.gitignore` or VS Code's exclude settings
  cover.
- When this feature starts, an empty **VS Code Tools Bridge** tab opens and closes at once.
- A Claude Code update can stop the chip from showing the selection. The **VS Code Tools
  Bridge** output channel then says so, and the prompt hook from the install steps gives Claude
  the selection.

Settings:

| Setting | Default | Effect |
|---------|---------|--------|
| `vscodeToolsBridge.markdownEditor.selection` | `true` | Sends the Markdown Editor's selection to Claude. A change takes effect without a reload. |

## Chat links open in the editor you chose

A file link in Claude Code's chat opens in the editor VS Code uses for that file type. That is
the Markdown Editor for `.md` when you set it in `workbench.editorAssociations`, or a PDF viewer
from an extension. Without the bridge, Claude Code opens every link in the text editor
([anthropics/claude-code#81482](https://github.com/anthropics/claude-code/issues/81482)).

Limits:

- A link to a line or a heading in such a file opens the file at the top.
- A Claude Code update can break this. Links then open in the text editor, and the **VS Code
  Tools Bridge** output channel says so.

Settings:

| Setting | Default | Effect |
|---------|---------|--------|
| `vscodeToolsBridge.claudeCode.chatLinks` | `true` | Opens chat links in the editor you chose. A change takes effect without a reload. |

## Install

You need VS Code 1.138 or later, Node 22.18 or later, and the `code` and `claude` commands on
your PATH. The bridge is not on the Marketplace, so you install it from a clone of this repo.

With Claude Code, start `claude` in the clone and ask it to install the bridge. Its
`install-vscode-tools-bridge` skill runs the setup script and makes the settings edits. It asks
you before it changes each file.

Without the skill, run this in the clone:

```sh
npm run setup
```

The script builds the extension, installs it into VS Code and adds `vscode-tools` to Claude
Code. It then prints the steps left to you, with the clone's paths filled in.

By hand:

1. Build and install the extension:

   ```sh
   npm ci
   npm run package
   code --install-extension vscode-tools-bridge-0.0.1.vsix --force
   ```

2. Add the MCP server to Claude Code, with the absolute path to `launcher.ts`:

   ```sh
   claude mcp add --scope user vscode-tools -- node /path/to/vscode-tools-bridge/launcher.ts
   ```

3. Reload each open VS Code window with **Developer: Reload Window**.
4. Optional: add the prompt hook to `~/.claude/settings.json`. With it, each prompt tells Claude
   the browser pages you share, the images you have open and your Markdown Editor selection.

   ```json
   "hooks": {
     "UserPromptSubmit": [
       { "hooks": [{ "type": "command", "command": "node \"/path/to/vscode-tools-bridge/prompt-hook.ts\"", "timeout": 5 }] }
     ]
   }
   ```

To check the install, start `claude` in the window's first workspace folder or a folder below
it. `/mcp` lists `vscode-tools` as connected, and the **VS Code Tools Bridge** output channel
logs each call. After a window reload, run `/mcp` and reconnect `vscode-tools`.

To update, run `git pull` and `npm run setup`, then reload the VS Code windows.

The bridge is on in every window with a local folder open. To turn it off in a workspace, set
`"vscodeToolsBridge.enabled": false` in its settings. With two windows on the same first
folder, Claude reaches the one opened last.

MIT licence. See [LICENSE](LICENSE).
