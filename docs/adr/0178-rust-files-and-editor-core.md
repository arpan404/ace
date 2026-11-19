# 0178. Files and the editor core move to Rust

Status: accepted, 2026-11-17

## Context

The Files panel asks the daemon for the checkout in one call, which walks it breadth-first and
stops at 1,000 paths. On a real repository that runs out two levels down: deeper folders show
half their contents or none, and "Search by name to find more" is the only way past it. The tree
never refreshes when an agent writes a file. The TypeScript watcher, path index and listing have
grown separately in `packages/workspace`, `packages/files` and `packages/context`, and the person
reports change watching as unreliable. The text view is a list of highlighted lines with a plain
textarea for editing; it has no multi-cursor, undo history or incremental highlighting.

The bar the person set is VS Code: open any folder of any checkout at once, see changes within
about 100 ms, quick-open over a million paths without lag, and an editor to match.

## Decision

1. A Rust process, `ace-files` (`native/files`), owns listing, watching, the quick-open path
   index, content search and file I/O for every checkout. The daemon supervises it as it does
   `ace-media`, and talks to it over framed JSON on stdio with binary bodies for file bytes.
2. The tree lists one folder per request, paged, with no total cap. Open folders update live from
   the watcher. Ignored entries are listed and dimmed rather than hidden.
3. The editor's text core (`native/editor`) is Rust built to Wasm: a rope buffer, transactions,
   undo, multiple selections, find and gutter marks. Rendering and input stay in the DOM, because
   IME, clipboard and accessibility live there. Electron stays (see the 2026-11-09 decision).
4. Highlighting is markit's, which gains a line-level incremental API, so chat code blocks and the
   editor share one highlighter, one grammar set and one set of colours.
5. Hard parts come from established crates: `ignore`, `notify`, `grep-*`, `cap-std`, `ropey`,
   `imara-diff`, `encoding_rs`. Licences are limited to the permissive set in each `deny.toml`
   (CC0-1.0 is allowed in `native/files` for `notify`).
6. When the Rust paths ship, the TypeScript list, watch, search and path-index code is deleted.
   There is no fallback path: the supervisor restarts `ace-files` and requests fail with a
   retryable error while it is down.
7. File versions keep their current format, so drafts stored by older builds still compare.

## Consequences

- Releases build and sign one more native binary per platform, and a Wasm module for the clients.
- Older clients keep working: the existing `list` operation stays until no shipped client uses it.
- Linux watching keeps inotify watches out of excluded folders, so large `node_modules` trees don't
  use up the per-user watch limit.
- The build plan and crate contracts live in `docs/files/plan.md`.
