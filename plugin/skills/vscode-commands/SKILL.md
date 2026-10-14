---
name: vscode-commands
description: Use when running VS Code commands through the vscode-tools MCP server's execute_command, such as go to definition, find references or symbol search through the language server, showing the user a diff, opening the git change of a file, or opening a review comment box on a diff line. Covers the argument markers, 0-based and 1-based positions, URIs, commands that return before the editor opens, and keeping the user's focus.
---

# VS Code commands through execute_command

`execute_command` runs any VS Code command in the window the session works in and returns its
result as JSON. `list_commands` finds command IDs by a substring, such as `git.` or `comment`. The
user's `vscodeBridge.executeCommand.allow` and `deny` settings decide which commands run.

## Arguments

Arguments are a JSON array. Three markers become VS Code objects:

- `{"$uri": "src/a.ts"}` is a file. A relative path starts at the window's first workspace folder.
  A string with `scheme://` is parsed as a URI, so a URI with an empty authority needs three
  slashes, such as `pr:///repo/file.ts?…`.
- `{"$position": {"line": 9, "character": 4}}` is a position.
- `{"$range": {"start": {…}, "end": {…}}}` is a range.

Positions and ranges, in the arguments and in the results, are **0-based**, as in the VS Code
API: line 10 in the editor is `"line": 9`. The `open_files` and `rename_symbol` tools and the
comment command below take 1-based lines.

## Ask the language server

Where a language server knows the answer, use it over a text search. It follows imports,
re-exports and aliases that a text search misses.

| Question | Command | Arguments |
|----------|---------|-----------|
| Where is it defined? | `vscode.executeDefinitionProvider` | `[{"$uri": …}, {"$position": …}]` |
| Who uses it? | `vscode.executeReferenceProvider` | `[{"$uri": …}, {"$position": …}]` |
| What implements this interface? | `vscode.executeImplementationProvider` | `[{"$uri": …}, {"$position": …}]` |
| What is the type's declaration? | `vscode.executeTypeDefinitionProvider` | `[{"$uri": …}, {"$position": …}]` |
| What is its type or documentation? | `vscode.executeHoverProvider` | `[{"$uri": …}, {"$position": …}]` |
| Where is a symbol by name? | `vscode.executeWorkspaceSymbolProvider` | `["makeStore"]` |

Each returns a list with a `uri` and a `range` per result; a symbol has them in its `location`.
The position must be on the symbol: read the line first and count its characters from 0.

A hover returns `contents`, a list of `{"value": "<Markdown text>"}`, such as a code block with the
type, and the `range` it covers. Use it for a type or a doc comment, where the type checker's
answer is shorter than reading the declaration.

`vscode.executeDocumentSymbolProvider` returns the whole symbol tree of a file, with three ranges
per symbol, so its result is large. Read the file instead when you need its outline.

## Show the user something

These commands change what the user sees. Run them when the user asks to see something, and
keep their focus where it is.

- **Open a file at a line:** the `open_files` tool, with `"src/a.ts:42"` and `background: true`.
- **A diff of two files:** `vscode.diff` with
  `[{"$uri": "<left>"}, {"$uri": "<right>"}, "<tab title>", {"preserveFocus": true}]`. Add
  `"selection": {"$range": …}` to the options to scroll to a change.
- **A file's uncommitted change:** `git.openChange` with `[{"$uri": "src/a.ts"}]`. It opens the
  same diff as a click on the file in the Source Control view, and does nothing for a file
  without changes.

## A review comment box

`workbench.action.addComment` opens an empty comment box on a line of the active editor, where a
comment provider, such as the GitHub Pull Requests extension, allows comments:

```json
{"command": "workbench.action.addComment", "args": [{"range": {"startLineNumber": 42, "endLineNumber": 42, "endColumn": 1}}]}
```

- Lines here are 1-based.
- First make the diff the active editor, for example with `vscode.diff`. The command acts on
  whatever editor is active.
- Run it once. On a line that already has a box, it closes the box.
- It moves VS Code's focus into the box. Keys the user types in VS Code at that moment land in
  the box, so tell the user.
- It opens the box only. The user writes or edits the text and submits it.

## Commands that open an editor

A command that opens a view or an editor can return before the editor is ready. When the next
step acts on that editor, wait a few seconds first, or check with the next call that the
editor is there. Run such steps one at a time, each after the previous one returns.
