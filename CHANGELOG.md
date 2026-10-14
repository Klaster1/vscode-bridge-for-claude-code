# Changelog

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
