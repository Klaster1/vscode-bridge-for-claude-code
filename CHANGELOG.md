# Changelog

## [0.10.0] - 2026-10-24

### Added

- The image in front in an editor group shows in Claude Code's selection chip.

## [0.9.0] - 2026-10-24

### Added

- Code blocks in Claude Code's chat get the colors of your editor and your color theme.
- The setting `vscodeBridge.claudeCode.syntaxHighlighting` turns the chat code colors off.

## [0.8.1] - 2026-10-24

### Fixed

- Read Markdown Editor selections when a restored tab opens the editor at window start.

## [0.8.0] - 2026-10-23

### Changed

- The extension needs VS Code 1.142 or later.
- After you turn the selection setting on, reload the window to read Markdown Editor selections.

## [0.7.0] - 2026-10-21

### Added

- A shared browser page in front shows in Claude Code's selection chip as an opened file.
- Text you select on a shared browser page reaches Claude, in the chip and in the prompt note.

## [0.6.1] - 2026-10-21

### Fixed

- A Markdown Editor with no selection, or a click outside its text, still attaches the file.

## [0.6.0] - 2026-10-15

### Added

- Text you select in a SemanticDiff diff reaches Claude, as a Markdown Editor selection does.

### Changed

- `vscodeBridge.markdownEditor.selection` turns the SemanticDiff selection on and off too.

## [0.5.1] - 2026-10-14

### Added

- The extension has an icon in the Extensions view.

## [0.5.0] - 2026-10-14

### Changed

- VS Code 1.140 or later is required.

### Security

- Update the MCP SDK to 1.32.1, which fixes a high-severity flaw in its OAuth client.

## [0.4.0] - 2026-10-14

### Changed

- New extension ID `klaster1.vscode-bridge-for-claude-code`: uninstall `local.vscode-tools-bridge`.
- The settings start with `vscodeBridge.`, not `vscodeToolsBridge.`: rename yours in settings.json.
- In `argv.json`, set `enable-proposed-api` to `klaster1.vscode-bridge-for-claude-code`.
- The extension and the plugin find each other in a new folder: update both together.

### Fixed

- `execute_command` returns hover text, and the edits of renames, formats and code actions.

## [0.3.0] - 2026-10-14

### Added

- A Claude Code plugin connects Claude Code to VS Code. Install it with one `claude plugin` command.
- Claude knows the steps for sharp page screenshots, page videos, diffs and review comment boxes.

### Changed

- `npm run setup` installs the Claude Code plugin from the clone.

### Removed

- **Connect Claude Code** and its launcher files: the Claude Code plugin replaces them.
- To clean up, run `claude mcp remove vscode-tools` and delete the `prompt-hook.mjs` hook entry.

## [0.2.0] - 2026-10-14

### Added

- Uninstalling the extension removes its Claude Code server, prompt hook and launcher files.

### Changed

- Connect Claude Code keeps a working registration, and restores the old one if the new one fails.
- The Extensions view describes what the extension does.

### Fixed

- The bridge starts on Linux and macOS on a first run.
- `npm run setup` no longer stops at a packaging question that aborts the build.
- `npm run setup` adds the prompt hook to the settings file Claude Code reads.
- A quick restart of a window no longer leaves a stale bridge listening.
- A launcher that starts while a window restarts connects instead of failing.
- The launcher names the Node version it needs when Node is too old.

### Security

- A workspace's settings can no longer change the `execute_command` allow and deny lists.
- The bridge closes a connection that sends no token within 5 seconds.

## [0.1.0] - 2026-10-14

### Added

- Claude knows when to use the bridge: page screenshots, viewport sizes, go to definition, diffs.

## [0.0.1] - 2026-10-14

### Added

- Claude uses VS Code's tools: diagnostics, rename, commands, open files, Copilot search, terminal.
- Claude drives VS Code's integrated browser and sees the pages you share with it.
- Claude sees the image files you have in front, in the chat panel and in the CLI.
- Claude sees your Markdown Editor selection, in the chat panel and in the CLI.
- File links in Claude Code's chat open in the editor you chose for the file type.
- Setting names in the README open the Settings editor at that setting.
- Install from a release, then run **Connect Claude Code** to connect Claude Code to VS Code.
- `npm run setup` installs the bridge from a clone of the repo.
