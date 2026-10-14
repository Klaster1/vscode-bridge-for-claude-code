---
name: install-vscode-tools-bridge
description: Use when the user asks to install, set up, update or reinstall the VS Code Bridge for Claude Code from this clone, after a `git pull`, or to check that the bridge works ("is vscode-tools connected", "the bridge tools are missing"). Runs the setup script, makes the settings edits it only prints, each with the user's consent, and checks the result.
---

# Install or update the VS Code Bridge for Claude Code

The bridge has two parts: a VS Code extension, and the `vscode-bridge` Claude Code plugin in
`plugin/`. The plugin holds the `vscode-tools` MCP server, the prompt hook and the skills.
`npm run setup` installs both: the extension into VS Code, and the plugin from this clone, where
it loads in place. The one edit left to you is `argv.json`, and it needs the user's consent.

The bridge is on in every VS Code window by default. To turn it off in one workspace, set
`"vscodeToolsBridge.enabled": false` in that workspace's settings.

## Rules

- **Ask before each file you change by hand.** Name the file, show the exact change, and edit
  only after the user agrees. A "no" skips that step; go on with the next one.
- **Keep the rest of the file.** Merge your change into what is there. `argv.json` and
  VS Code's `settings.json` allow comments, so edit them as text and keep the comments.
- **Never reload or restart VS Code yourself.** A reload restarts the extensions in that
  window, Claude Code's chat included. Ask the user to do it.

## Install

1. **Check the tools.** Run `node --version` (22.18 or later), `code --version` (1.138 or
   later) and `claude --version`. If `code` is missing, the user can add it to the PATH
   with the VS Code command **Shell Command: Install 'code' command in PATH** (macOS), or
   install the VSIX by hand as step 2 says.
2. **Run the script** in the clone's root folder:

   ```sh
   npm run setup
   ```

   It runs `npm ci` and `npm run package`, installs the VSIX with
   `code --install-extension <vsix> --force`, then runs `claude plugin marketplace add <clone>`
   and `claude plugin install vscode-bridge@vscode-bridge`. Those two add the marketplace and
   the plugin to Claude Code's user settings, so tell the user before you run it. It ends with
   a numbered list, "What is left to do by hand", with this clone's paths filled in. A step
   that failed appears at the top of that list, with the command to run.
3. **Skip the browser confirmations**, if the user wants it. Without this, VS Code shows a
   dialog before `open_browser_page`, `navigate_page` and `run_playwright_code` run.
   1. In `~/.vscode/argv.json`, add `"enable-proposed-api": ["local.vscode-tools-bridge"]`.
      If the key exists, add the ID to its array. The user can open the file with the
      VS Code command **Preferences: Configure Runtime Arguments**.
   2. Ask the user to quit and start VS Code again. A window reload does not read
      `argv.json`.
4. **Ask the user to reload each open VS Code window** with **Developer: Reload Window**, so
   it runs the installed version. Skip this when they restarted VS Code in step 3.
5. **Check the result**, as the "Check" section says.

## Update after a `git pull`

Run `npm run setup` again, then ask the user to reload each VS Code window. The plugin loads
from the clone, so its changes take effect in the next Claude Code session.

## Check

1. Ask the user to start a new Claude Code session in the window's first workspace folder,
   or a folder below it. `/mcp` lists `plugin:vscode-bridge:vscode-tools` as connected.
2. Call the `list_workspaces` tool. Its `bridge.loadedFrom` path is in VS Code's extensions
   folder, under `local.vscode-tools-bridge-<version>`, with the version from
   `package.json`. Any other path means VS Code runs another copy of the extension.
3. Ask the user to open the **VS Code Bridge for Claude Code** output channel (**View: Toggle Output**,
   then pick the channel). It shows `Listening on <pipe> for <folder>`, and one line per
   tool call. The same log is on disk, in the newest session folder under VS Code's
   `logs` folder: `window<N>/exthost/local.vscode-tools-bridge/VS Code Bridge for Claude Code.log`.
4. To check the hook, run `echo '{"cwd":"<the workspace folder>"}' | node plugin/prompt-hook.mjs` in the clone.
   It exits with 0. It prints JSON only while a page is shared, an image is in front in an
   editor group or text is selected in a Markdown Editor; otherwise it prints nothing.
