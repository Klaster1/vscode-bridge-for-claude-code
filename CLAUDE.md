# VS Code Bridge for Claude Code

A VS Code extension. It serves a window's tools to Claude Code over MCP, and patches VS Code
and Claude Code at runtime so that Claude sees what the user has open.

## Layout

- `src/extension.ts`: activation, the per-window MCP server on a named pipe (a Unix socket on
  macOS and Linux), the discovery file, the URI handler for setting links, and the switch for
  each runtime patch.
- `src/tools.ts`: the MCP tools. Some use the stable API. The rest forward VS Code's and
  Copilot's language-model tools from `vscode.lm.tools`. `src/render.ts` turns their
  prompt-tsx results into text.
- `src/discovery.ts`: where a window records its pipe and token, and how the launcher finds
  the window for a folder.
- `src/markdownSelection.ts`, `src/chatLinks.ts`, `src/claudeApi.ts`: the runtime patches.
- `src/shims.ts`: writes `launcher.mjs` and `prompt-hook.mjs` to a fixed folder. Claude Code's
  config points at them, and each imports the files of the extension version that wrote it.
- `src/connect.ts`: the **Connect Claude Code** command. It registers the MCP server and the
  prompt hook with the shims, for an install from a release.
- `launcher.ts`: the stdio MCP server that Claude Code starts. It finds the window for its
  working directory and relays bytes to it.
- `prompt-hook.ts`: the `UserPromptSubmit` hook. It adds the shared browser pages, the open
  images and the Markdown Editor selection to each prompt.
- `setup.ts` (`npm run setup`): installs from a clone. The
  `.claude/skills/install-vscode-tools-bridge/` skill runs it and makes the settings edits.
- `test/`: see the "Tests" section.

## How it runs

- VS Code's extension host and Node 22.18+ run the `.ts` files directly, with type stripping.
  There is no bundler and no build output.
- The code stays erasable TypeScript: no enums, namespaces, parameter properties or JSX.
  Imports name the `.ts` file.
- `launcher.ts`, `prompt-hook.ts`, `setup.ts` and the files they import run in plain Node, so
  they import nothing from `vscode`.
- `npm run package` builds the VSIX with `vsce`. The VSIX bundles `node_modules`, so a runtime
  dependency goes in `dependencies`. `.vscodeignore` keeps tests and development files out.

## Runtime patches

Each patch relies on internals of VS Code or Claude Code. After either one updates, check each
internal below against the new version. VS Code's Markdown Editor is in the VS Code install,
under `resources/app/extensions/markdown-language-features/`. Claude Code's code is
`extension.js` in its extension folder, `anthropic.claude-code-<version>`.

| Internal | Patch | Where to check |
|----------|-------|----------------|
| The `html` setter and `postMessage` on the webview prototype that all extensions share | Markdown Editor selection; finding Claude Code's chat webviews | `ExtHostWebview`, in VS Code's `src/vs/workbench/api/common/extHostWebview.ts` |
| The Markdown Editor page's meta tags (`vscode-markdown-editor-script-nonce`, `-initial-state`, `-message-secret`), and its `acquireVsCodeApi().setState` calls with `selection.anchor` and `selection.active` | Markdown Editor selection | `dist/extension.js` builds the page; `markdown-editor-out/editor.js` runs in it |
| Claude Code's own `vscode` API object, reached with `createRequire` from its `extension.js` | all Claude Code patches | `src/claudeApi.ts` |
| The `selection_changed` request that Claude Code posts to its chat webview, inside `{ type: 'from-extension', message: … }` | the selection chip | search `extension.js` for `selection_changed` |
| Claude Code's `window.onDidChangeTextEditorSelection` listeners | the selection for the CLI over `/ide` | search `extension.js` for `onDidChangeTextEditorSelection` |
| Claude Code's chat-link handler: `showTextDocument(uri)`, then `vscode.open` when that rejects | chat links | search `extension.js` for `showTextDocument` |

When an internal is missing or has changed, the patch logs it once in the output channel and
leaves that part off. No error reaches the patched extension. Links then open in the text
editor, and the prompt hook still gives Claude the Markdown Editor selection.

The `*` activation event stays: the `onDidChangeTextEditorSelection` wrapper must be in place
before Claude Code subscribes.

The tests check the patches against a stand-in, not against Claude Code. After a Claude Code
update, check them in a real VS Code with Claude Code: select text in a Markdown Editor, check
the selection chip and the CLI over `/ide`, and open a chat link to a `.md` file.

## Tests

- `npm run typecheck` runs `tsc` with no output files. A new top-level `.ts` file goes into the
  `include` list of `tsconfig.json`.
- `npm test` runs two offline checks, `test/render-check.ts` and `test/glob-check.ts`, and then
  the end-to-end test, `test/run.ts`.
- The end-to-end test downloads VS Code 1.138.0 into `.vscode-test/`. It starts it with its own
  user data, extensions, discovery folder and Claude Code config, and calls every tool through
  the launcher shim. The user's own VS Code and Claude Code config stay untouched.
- `test/standin/` is an extension with Claude Code's ID, `anthropic.claude-code`. It plays
  Claude Code's chat webview, selection listener and chat-link handler, since the test cannot
  install Claude Code.
- In a terminal inside VS Code, or under Claude Code started from one, unset the variables VS
  Code passes down. With them set, the dialog and "Share with Agent" checks can fail:

  ```sh
  env -u ELECTRON_RUN_AS_NODE -u VSCODE_IPC_HOOK_CLI -u VSCODE_PID -u VSCODE_CWD -u VSCODE_NLS_CONFIG -u VSCODE_HANDLES_UNCAUGHT_ERRORS -u VSCODE_ESM_ENTRYPOINT -u VSCODE_CODE_CACHE_PATH -u VSCODE_CRASH_REPORTER_PROCESS_TYPE npm test
  ```

- `BRIDGE_TEST_VSIX=<path>` tests a built VSIX instead of the source. The header of
  `test/run.ts` lists the other variables.
- The "toolbar Share with Agent button found" check runs on Windows only, and it is known to
  flake. Run the test again before you look for a cause.

## Versioning

The version in `package.json` follows semver. The first release is 0.0.1. You decide when a
change needs a new version and which part to bump.

## README

The README is for users of the extension. It has one section per feature, a "Settings"
section and an "Install" section.

- A feature section says what the user gets and what they do to use it.
- Leave out internals and implementation details, such as hooks, patches and message formats.
- Leave out a limit the user can't act on.
- State facts plainly, with no hedges.
- No licence line: `LICENSE` holds the licence.
- Link each setting name to the Settings editor, with
  `vscode://local.vscode-tools-bridge/settings?id=<setting ID>` as the target.
- Write short, plain sentences in simple present tense and active voice, one idea each.

## Code comments

- Comment only what the code can't show: a reason, a workaround, a changed default, the failure
  a line prevents. Cut a sentence that the names, types or body already say.
- Put a comment on the line it is about, as a trailing comment where it fits.
- Check every reason at its source, such as VS Code's or Claude Code's code. A wrong reason is
  worse than none.
- Match the density of the code around it. A module starts with a short header on what it does
  and why.
