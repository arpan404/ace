# Workspace file service

`@ace/workspace` is a Node 24+ service for browsing a thread's workspace. It has no daemon or client dependencies.

```ts
import { createWorkspace, WorkspaceError } from "@ace/workspace";

const workspace = await createWorkspace("/absolute/worktree");
const page = await workspace.list({ dir: "src", depth: 2, limit: 100 });
const next = page.nextCursor
  ? await workspace.list({ dir: "src", depth: 2, limit: 100, cursor: page.nextCursor })
  : null;
const content = await workspace.read({ path: "src/index.ts", offset: 0, length: 4096 });
const controller = new AbortController();
const found = await workspace.search({
  query: "createWorkspace",
  glob: "**/*.ts",
  limit: 100,
  signal: controller.signal,
});
const subscription = await workspace.watch({ onChange: (changes) => console.log(changes) });
await subscription.dispose();
```

## Paths and errors

All operation paths use `/` and are relative to the canonical root. `dir: ""` and `dir: "."` refer to the root. Paths containing `..`, NUL, backslashes, or Unix/Windows absolute paths are rejected. Every existing component is checked with `realpath`, including intermediate links that leave the root and link back into it.

The service binds to the root's device/inode identity. Replacing the root invalidates it. Reads resolve and inspect the file, open with `O_NOFOLLOW | O_NONBLOCK`, compare the descriptor's device/inode, and revalidate containment and identity before reading through that descriptor. A swapped file or parent is rejected; a later rename cannot redirect an already opened descriptor. Directories are revalidated around enumeration, and every returned child has its own checked metadata. This handles concurrent editor/agent replacements without handing unchecked workspace paths to ripgrep.

Explicit escape paths produce `PATH_ESCAPE`; discovered escaping or disappearing entries are omitted from traversal. In-root file symlinks can be read and appear as `symlink` entries. Recursive traversal, search and watching do not follow directory symlinks, avoiding cycles and duplicate results. Explicit listing requests can browse an in-root directory link; ignore rules use its actual target directory.

Failures are `WorkspaceError` with a typed `code`. Codes include `INVALID_PATH`, `PATH_ESCAPE`, `PATH_CHANGED`, `NOT_FOUND`, `NOT_DIRECTORY`, `NOT_FILE`, `PERMISSION_DENIED`, `IO_ERROR`, `INVALID_ARGUMENT`, `INVALID_CURSOR`, `LIMIT_EXCEEDED`, `ABORTED`, and `SEARCH_FAILED`.

## Listing and reading

`list({ dir, depth = 1, includeIgnored = false, limit = 500, cursor? })` returns `{ entries, nextCursor, truncated }`. Entries contain root-relative `path`, `type`, byte `size`, numeric `mtime` in milliseconds, and `ignored`.

Listings use sorted preorder, with directory entries preceding their descendants. Depth is 1 to 100; pages hold at most 1,000 entries. Cursors bind to the normalized directory, depth and ignore setting. They are offsets in a fresh traversal, so concurrent tree changes can move entries between pages. Restart paging after a watch notification when an exact current listing matters. Enumeration is bounded to 10,000 entries per directory and 100,000 visited entries per operation; exceeding either fails with `LIMIT_EXCEEDED` rather than returning an incomplete snapshot.

Ignore classification uses NUL-delimited batches of 256 paths through `git check-ignore --stdin -z`. Nested `.gitignore`, negations, `.git/info/exclude`, and Git's configured excludes apply. Tracked files stay visible even if their names match an ignore pattern. Outside a Git worktree, or without Git installed, no ignore rules apply. Rules are checked afresh during every traversal. `.git` entries and descendants are omitted even with `includeIgnored: true`.

`read({ path, offset = 0, length = 1 MiB })` uses byte offsets and caps each result at 1 MiB. It returns size, mtime, offset, bytesRead and truncated. A NUL in the first 8 KiB produces `binary: true` with metadata only, even when the requested range starts later. Otherwise it returns `binary: false`, UTF-8 `text`, and `encoding: "utf-8" | "utf-8-lossy"`. Invalid sequences use replacement characters. A range splitting a UTF-8 character can also have a lossy hint. `truncated` means bytes remain after the returned range; reads beyond EOF return empty text.

## Search

`search({ query, regex = false, caseSensitive = true, glob?, limit, byteBudget = 16 MiB, signal? })` returns `{ matches, truncated, bytesScanned, backend }`. Each occurrence has a root-relative path, 1-based line and UTF-8 byte column, and a preview capped at 512 characters. Globs use Node's `path.matchesGlob` against the root-relative path. Hidden files are searched; ignored files, `.git` internals, symlinks and any file containing NUL are skipped.

Both backends receive the same safely opened, bounded UTF-8 file content. Ripgrep searches stdin with `rg --json --no-config`; JSONL is decoded incrementally, unknown event types are skipped, and the child is killed and reaped when the match limit or cancellation is reached. Missing ripgrep selects the pure Node backend automatically. `createWorkspace(root, { ripgrep: null })` forces Node, or `ripgrep: "/path/to/rg"` selects an executable.

Search skips files larger than 1 MiB or the remaining byte budget and marks the result truncated. The total budget is at most 16 MiB, with at most 10,000 matches and 4 MiB of ripgrep JSON output per file. `bytesScanned` includes binary probes. `truncated` also indicates a reached match limit, even if no further match exists. Byte budgets count input, before newline normalization and lossy UTF-8 decoding.

Queries are single-line, at most 4,096 characters. Regex supports the shared JavaScript/ripgrep subset. Shorthand classes have JavaScript semantics in both backends, with Unicode case folding; negated shorthands inside brackets, lookaround, backreferences, Unicode property classes/boundaries and multiline expressions are rejected. A leading UTF-8 BOM is removed; CRLF, CR and Unicode line separators are normalized consistently before matching. Columns refer to this decoded text. Adjacent empty regex matches follow ripgrep semantics. Node regex work runs in a worker so cancellation cannot be blocked by backtracking; a five-second execution budget terminates pathological expressions with `SEARCH_FAILED`. The worker is disposed after every search. An aborted operation rejects with `ABORTED` and reaps its owned process or worker.

## Watching

`watch({ onChange, onWarning? })` returns an independent subscription with `mode`, `flush()` and async `dispose()`. Each callback receives a sorted batch of `{ path, kind: "created" | "changed" | "deleted" }` relative to the root.

The native backend uses recursive `fs.watch` and a 100 ms coalescing window. It subscribes before the initial snapshot and reconciles notifications against the last visible tree. Multiple notifications for the same path produce one net change per batch. Creating and deleting a file entirely within a window may produce no change. Ignore-rule updates can appear as creation/deletion when a path enters/leaves the visible tree. Deleted directories include deletions for their previously visible descendants.

Snapshots use the same bounded traversal as listing. Scans are serialized and repeat notifications request at most one pending follow-up. A failed scan warns and retains the previous snapshot instead of inventing deletions. `flush()` requests an immediate full reconciliation and awaits delivery, useful before refreshing a listing. `dispose()` cancels owned Git processes, closes the native watcher, clears timers, and waits for in-flight work; it is idempotent and no callback follows completion.

Unsupported recursive watching and watcher-limit errors fall back to polling with a clear warning via `onWarning`, or `console.warn` by default. Polling checks every 100 ms and uses the same reconciliation window. `{ watchMode: "polling" }` forces this backend. Native notifications inspect only affected paths and subtrees. Missing filenames, explicit flushes and ignore-rule changes trigger a full scan. A child index makes directory deletion proportional to the deleted subtree.

## Verification and sources

`bun run test packages/workspace` runs public API tests with temporary directories, real Git repositories, real ripgrep processes, a real swapping child process, and native filesystem notifications. No provider CLI or recorder is used. Development contract tests require `git` and `rg`; CI installs ripgrep when needed. `bun run check` verifies the whole repository. `bun run --filter @ace/workspace bench` measures a 1,000-file native watch and Node search without a timing gate.

The implementation is written fresh from this task and these primary interfaces: [Node filesystem API](https://nodejs.org/api/fs.html), [Node path API](https://nodejs.org/api/path.html), [Git check-ignore](https://git-scm.com/docs/git-check-ignore), and the installed ripgrep's `rg --help` and JSON output.

A representative macOS run with 1,000 files reported 321 ms watch setup, 161 ms notification delivery including the 100 ms window, 309 ms explicit full refresh, and 35 ms Node search for 100 occurrences. These measurements explain why full scans are reserved for polling, unknown notifications, ignore-rule updates and explicit refreshes; they are not test thresholds.

The workspace command reader owns bounded byte streams and NUL-framed Git output. Provider-kit's public process API is line-oriented and cannot preserve arbitrary Git filenames or bound a JSON line before its newline, so this service uses a separate short-lived command shell. It never starts provider CLIs.
