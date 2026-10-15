# VS Code Bridge for Claude Code

A VS Code extension. It serves a window's tools to Claude Code over MCP, and patches VS Code
and Claude Code at runtime so that Claude sees what the user has open.

## Layout

- `src/extension.ts`: activation, the MCP server for each connection, the URI handler for
  setting links, and the switch for each runtime patch.
- `src/bridgeServer.ts`: the per-window listener on a named pipe (a Unix socket on macOS and
  Linux), the token check on each connection, and the discovery file.
- `src/instructions.ts`: the MCP server instructions, which tell Claude when the tools fit.
- `src/tools.ts`: the MCP tools. Some use the stable API. The rest forward VS Code's and
  Copilot's language-model tools from `vscode.lm.tools`. `src/render.ts` turns their
  prompt-tsx results into text.
- `src/shell.ts`: quotes a command line for Windows, for `setup.ts` and the tests.
- `plugin/`: the `vscode-bridge` Claude Code plugin. The repo is its marketplace,
  `.claude-plugin/marketplace.json`. An installed plugin loads only its own files, so all it
  runs lives in `plugin/`:
  - `.claude-plugin/plugin.json` declares the `vscode-tools` MCP server, and
    `hooks/hooks.json` the prompt hook. Its `version` equals the one in `package.json`.
  - `launcher.mjs` and `prompt-hook.mjs` check that Node strips types, then import
    `scripts/launcher.ts` and `scripts/prompt-hook.ts`.
  - `scripts/launcher.ts`: the stdio MCP server. It finds the window for its working directory
    and relays bytes to it.
  - `scripts/prompt-hook.ts`: the `UserPromptSubmit` hook. It adds the shared browser pages, the
    open images and the selection in the Markdown Editor or a SemanticDiff diff to each prompt.
  - `scripts/discovery.ts`: where a window records its pipe and token, and how the launcher
    finds the window for a folder. The extension imports it from here.
  - `skills/`: the skills that show Claude how to use the tools. `src/instructions.ts` names
    them.
- `docs/icon.svg`: the source of the extension icon. `scripts/generate-icon.ts` renders it to `icon.png`,
  which `package.json` names. `npm run icon` and `npm run package` run it, and `test/icon-check.ts`
  fails when the committed PNG is stale. Edit the SVG, never the PNG.
- `setup.ts` (`npm run setup`): installs from a clone: the VSIX into VS Code, and the plugin from
  the clone, where it loads in place. The `.claude/skills/install-vscode-bridge-for-claude-code/` skill
  runs it and makes the `argv.json` edit.
- `test/`: see the "Tests" section.

## How it runs

- VS Code's extension host and Node 22.18+ run the `.ts` files directly, with type stripping.
  There is no bundler and no build output.
- The code stays erasable TypeScript: no enums, namespaces, parameter properties or JSX.
  Imports name the `.ts` file.
- The plugin's files and `setup.ts` run in plain Node, so they import nothing from `vscode`.
  `src/bridgeServer.ts` does the same, so an offline check can run it. The plugin has no
  `node_modules`, so its files import only Node's own modules.
- `npm run package` builds the VSIX with `vsce`. The VSIX bundles `node_modules`, so a runtime
  dependency goes in `dependencies`. `.vscodeignore` keeps tests and development files out.

## Runtime patches

Each patch relies on internals of VS Code, Claude Code or SemanticDiff 0.10.0. After any of them
updates, check each internal below against the new version. VS Code's Markdown Editor is in the
VS Code install, under `resources/app/extensions/markdown-language-features/`. Claude Code's code
is `extension.js` in its extension folder, `anthropic.claude-code-<version>`. SemanticDiff's code
is `out/extension/main.js` and `out/webview/script.js` in its extension folder,
`semanticdiff.semanticdiff-<version>-<platform>`.

| Internal | Patch | Where to check |
|----------|-------|----------------|
| The `html` setter and `postMessage` on the webview prototype that all extensions share | Markdown Editor and SemanticDiff selection; finding Claude Code's chat webviews | `ExtHostWebview`, in VS Code's `src/vs/workbench/api/common/extHostWebview.ts` |
| The Markdown Editor page's meta tags (`vscode-markdown-editor-script-nonce`, `-initial-state`, `-message-secret`), and its `acquireVsCodeApi().setState` calls with `selection.anchor` and `selection.active` | Markdown Editor selection | `dist/extension.js` builds the page; `markdown-editor-out/editor.js` runs in it |
| SemanticDiff's page: `<title>SemanticDiff</title>`, `id="old-path"` and `id="new-path"`, and `initialState = JSON.parse(decodeURIComponent("…"))` with `input.original`, `input.modified` and `title` | SemanticDiff selection | `out/webview/index.html` is the template; search `main.js` for `setWebviewHTML` |
| The `SetState` message SemanticDiff posts to its page, with the same `state` fields | SemanticDiff selection | search `main.js` for `"SetState"` |
| The panel's view type `SemanticDiff` and its title, which is its tab's label | SemanticDiff selection | search `main.js` for `createWebviewPanel` |
| The viewer in SemanticDiff's page: the only class that assigns `this.selectionText`; its `selection` (`start` and `end` as `row`, `line`, `offset`, and `leftSide`, `hasOffset`); `renderer.rows` (`type` 2 with `left` and `right` items `{ canSelect, line.text, code.text }`, `type` 1 for collapsed lines); `renderer.simplifySelection`; and its `updateSelectionText` and `clear` methods | SemanticDiff selection | search `script.js` for `selectionText` and `getSelectionText` |
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
update, check them in a real VS Code with Claude Code: select text in a Markdown Editor and in a
SemanticDiff diff, check the selection chip and the CLI over `/ide`, and open a chat link to a
`.md` file.

## Tests

- `npm run typecheck` runs `tsc` with no output files. A new top-level `.ts` file goes into the
  `include` list of `tsconfig.json`.
- `npm test` runs the offline checks, the `test/*-check.ts` files, and then the end-to-end test,
  `test/run.ts`. The offline checks run on every platform. They use the small runner in
  `test/harness.ts`, and start no VS Code.
- The end-to-end test runs on Windows only, as CI does, because `test/window-helper.ps1` drives
  the VS Code windows through Win32 and UI Automation. On another platform it stops at once with
  a message. It downloads VS Code 1.140.0 and SemanticDiff 0.10.0 into `.vscode-test/`. It
  starts VS Code with its own user
  data, extensions, discovery folder and Claude Code config, and calls the tools through the
  plugin's launcher and prompt hook, with the command lines from the plugin's manifests. The user's
  own VS Code and Claude Code config stay untouched. It selects text in SemanticDiff's diff
  panel with the mouse, over the Chrome DevTools Protocol.
- `test/standin/` is an extension with Claude Code's ID, `anthropic.claude-code`. It plays
  Claude Code's chat webview, selection listener and chat-link handler, since the test cannot
  install Claude Code.
- In a terminal inside VS Code, or under Claude Code started from one, unset the variables VS
  Code passes down. With them set, the dialog and "Share with Agent" checks can fail:

  ```sh
  env -u ELECTRON_RUN_AS_NODE -u VSCODE_IPC_HOOK_CLI -u VSCODE_PID -u VSCODE_CWD -u VSCODE_NLS_CONFIG -u VSCODE_HANDLES_UNCAUGHT_ERRORS -u VSCODE_ESM_ENTRYPOINT -u VSCODE_CODE_CACHE_PATH -u VSCODE_CRASH_REPORTER_PROCESS_TYPE npm test
  ```

- `claude plugin validate --strict plugin` and `claude plugin validate --strict .` check the
  plugin and the marketplace. CI runs both.
- `BRIDGE_TEST_VSIX=<path>` tests a built VSIX instead of the source. The header of
  `test/run.ts` lists the other variables.
- The "toolbar Share with Agent button found" check runs on Windows only, and it is known to
  flake. Run the test again before you look for a cause.
- Every user-visible feature or fix comes with a test that fails without it. Add an end-to-end
  check to `test/run.ts`, or an offline check like the ones `npm test` runs first.

## Screenshots

The README images and `docs/social.png` come from `npm run screenshots`. It runs only locally:
it drives a real VS Code with the real Claude Code extension and makes no model calls.

When a change alters what a screenshot shows, regenerate the images, and commit them with
`docs/screenshots/inputs.json` in the same commit. The agent that makes the change does this.
A change to `src/` can alter a shot without changing the hash, so check that by eye.

`npm run check-screenshots` covers the inputs listed in `scripts/screenshot-inputs.ts`: the
git-tracked files of `package.json` without its `version`, the screenshot script and its
fixture, and the social preview page. It fails when the recorded input hash no longer matches or
an image is missing, and CI runs it.

## Versioning

The version in `package.json` follows semver. The first release is 0.0.1. You decide when a
change needs a new version and which part to bump.

Every version bump adds its section to `CHANGELOG.md` in the same commit:

- The heading is `## [x.y.z] - YYYY-MM-DD`, newest first, followed by `### Added`, `### Changed`,
  `### Deprecated`, `### Removed`, `### Fixed` or `### Security` as needed.
- Each bullet is one user-visible change in user terms, as in the README, with no internals.
- A bullet is one line of at most 100 characters, counted after the `- `, Markdown included.
- A change that users don't see, such as a test, a refactor or a doc edit, gets no entry.

`test/changelog-check.ts`, part of `npm test`, enforces these rules. It also checks that the top
version equals the one in `package.json`. VS Code shows the file in the extension's Changelog
tab. The release workflow uses the top section as the GitHub Release notes.

## Workflow

- Work on a branch and open a pull request. Merge it only when the `test` check is green.
- Branch protection needs a public repo or GitHub Pro, so this is a rule until then. Once the repo
  is public, this command creates a ruleset that requires a pull request and the `test` check on
  `main`:

  ```sh
  gh api repos/Klaster1/vscode-bridge-for-claude-code/rulesets --method POST --input - <<'JSON'
  {
    "name": "main",
    "target": "branch",
    "enforcement": "active",
    "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
    "rules": [
      { "type": "pull_request", "parameters": { "required_approving_review_count": 0, "dismiss_stale_reviews_on_push": false, "require_code_owner_review": false, "require_last_push_approval": false, "required_review_thread_resolution": false } },
      { "type": "required_status_checks", "parameters": { "strict_required_status_checks_policy": false, "required_status_checks": [{ "context": "test" }] } }
    ]
  }
  JSON
  ```

## CI and releases

`.github/workflows/ci.yml` has two jobs.

- `test` runs on every pull request and every push to `main`, on a Windows runner, because the
  end-to-end test drives real VS Code windows. It runs `npm ci`, `npm run typecheck`,
  `claude plugin validate`, `npm test` and `npm run check-screenshots`, then builds the VSIX with
  `npm run package` and uploads it. CI uses no tokens and never makes screenshots.
- `release` runs after `test` passes on a push to `main`. If the tag `v<version>` does not
  exist, it creates the tag on that commit and publishes a GitHub Release with the VSIX and the
  top `CHANGELOG.md` section.

To release:

1. Bump `version` in `package.json`. Use semver, and choose the part yourself.
2. Add the matching `CHANGELOG.md` section in the same commit.
3. Land it on `main` through a pull request. CI tests it, then tags and releases it.

A failed run releases nothing. The next green run on `main` releases the version.

## README

The README is for users of the extension. It has one section per feature, a "Settings"
section and an "Install" section.

- A feature section says what the user gets and what they do to use it.
- Leave out internals and implementation details, such as hooks, patches and message formats.
- Leave out a limit the user can't act on.
- State facts plainly, with no hedges.
- No licence line: `LICENSE` holds the licence.
- Link each setting name to the Settings editor, with
  `vscode://klaster1.vscode-bridge-for-claude-code/settings?id=<setting ID>` as the target.
- Write short, plain sentences in simple present tense and active voice, one idea each.

## Code comments

- Comment only what the code can't show: a reason, a workaround, a changed default, the failure
  a line prevents. Cut a sentence that the names, types or body already say.
- Put a comment on the line it is about, as a trailing comment where it fits.
- Check every reason at its source, such as VS Code's or Claude Code's code. A wrong reason is
  worse than none.
- Match the density of the code around it. A module starts with a short header on what it does
  and why.
