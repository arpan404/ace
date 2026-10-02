# Workspace file service

`@ace/workspace` is a Node 24+ service for browsing a thread's workspace. It has no daemon or client dependencies. macOS and Linux installs require a C compiler: `bun install` builds the small Node-API descriptor bridge using MIT-licensed Node.js headers. The service and matching logic are TypeScript; the bridge exposes descriptor-relative filesystem syscalls missing from Node's filesystem API and creates POSIX input pipes.

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

The root's identity comes from an opened descriptor. The bridge opens the canonical root from `/`, rejecting symlinks in every component, then traverses relative to that root descriptor with `openat` and `O_NOFOLLOW`. Reads compare the opened file's device/inode with its expected metadata before use; `O_NONBLOCK` prevents replacement FIFOs from hanging opening. Root replacement invalidates the service. Descriptor-relative traversal establishes confinement even through coordinated ABA swaps of parents or root ancestors. Realpath checks enforce symlink policy and post-open checks detect ordinary replacements. Directory enumeration and child metadata use `fdopendir` and `fstatat` on the confined directory, with identity checks around enumeration.

Explicit escape paths produce `PATH_ESCAPE`; discovered escaping, disappearing or unsupported path forms are omitted from traversal and notifications. In-root file symlinks can be read and appear as `symlink` entries. Recursive traversal, search and watching do not follow directory symlinks, avoiding cycles and duplicate results. Explicit listing requests can browse an in-root directory link; ignore rules use its actual target directory.

Failures are `WorkspaceError` with a typed `code`. Codes include `INVALID_PATH`, `PATH_ESCAPE`, `PATH_CHANGED`, `NOT_FOUND`, `NOT_DIRECTORY`, `NOT_FILE`, `PERMISSION_DENIED`, `IO_ERROR`, `INVALID_ARGUMENT`, `INVALID_CURSOR`, `LIMIT_EXCEEDED`, `ABORTED`, and `SEARCH_FAILED`.

## Listing and reading

`list({ dir, depth = 1, includeIgnored = false, limit = 500, cursor? })` returns `{ entries, nextCursor, truncated }`. Entries contain root-relative `path`, `type`, byte `size`, numeric `mtime` in milliseconds, and `ignored`.

Listings use sorted preorder, with directory entries preceding their descendants. Depth is 1 to 100; pages hold at most 1,000 entries. Cursors bind to the normalized directory, depth and ignore setting. They are offsets in a fresh traversal, so concurrent tree changes can move entries between pages. Restart paging after a watch notification when an exact current listing matters. Enumeration is bounded to 10,000 entries per directory and 100,000 visited entries per operation; exceeding either fails with `LIMIT_EXCEEDED` rather than returning an incomplete snapshot.

Ignore classification uses NUL-delimited batches of 256 paths through `git check-ignore --stdin -z`. Nested `.gitignore`, negations, `.git/info/exclude`, and Git's configured excludes apply. Tracked files stay visible even if their names match an ignore pattern. Outside a Git worktree, or without Git installed, no ignore rules apply. Rules are checked afresh during every traversal. `.git` entries and descendants are omitted even with `includeIgnored: true`.

`read({ path, offset = 0, length = 1 MiB })` uses byte offsets and caps each result at 1 MiB. It returns size, mtime, offset, bytesRead and truncated. A NUL in the first 8 KiB produces `binary: true` with metadata only, even when the requested range starts later. Otherwise it returns `binary: false`, UTF-8 `text`, and `encoding: "utf-8" | "utf-8-lossy"`. Invalid sequences use replacement characters. A range splitting a UTF-8 character can also have a lossy hint. `truncated` means bytes remain after the returned range; reads beyond EOF return empty text.

## Search

`search({ query, regex = false, caseSensitive = true, glob?, limit, byteBudget = 16 MiB, signal? })` returns `{ matches, truncated, bytesScanned, backend }`. Each occurrence has a root-relative path, 1-based line and UTF-8 byte column, and a preview capped at 512 characters. Globs use Node's `path.matchesGlob` against the root-relative path. Hidden files are searched; ignored files, `.git` internals, symlinks and any file containing NUL are skipped.

Both backends consume safely opened descriptors in 64 KiB chunks. A bounded NUL probe precedes matching, then the same descriptor is streamed through UTF-8 decoding and newline normalization. Ripgrep searches batches of up to 64 real POSIX input pipes with `rg --json --no-config --threads 1`. Its JSON parser emits each submatch as that object closes, before the enclosing event or line completes. It retains only projected scalars, a 512-character preview and a bounded Unicode-boundary bitmap, so a dense line cannot force a full JSON event into memory. Unknown event types are skipped. Missing ripgrep selects the Node backend automatically. `createWorkspace(root, { ripgrep: null })` forces Node, or `ripgrep: "/path/to/rg"` selects an executable.

Search has no per-file 1 MiB cap. Files are searched through the remaining total byte budget, up to 16 MiB; a budget-cut prefix is searchable and marks the result truncated. The match limit is at most 10,000. `bytesScanned` counts physical bytes probed, including binary probes and bounded rg batch read-ahead. Counts can differ between backends when an early match limit stops traversal. Output bytes also have a cap derived from input bytes and the occurrence limit. `truncated` indicates a reached byte or match limit, even if no further match exists. Node retains complete lines for regex matching, with at most one budgeted unfinished line; previews are cached per line and byte offsets advance through disjoint prefixes.

Queries are single-line, at most 4,096 characters. Regex supports a shared JavaScript/ripgrep subset; malformed Unicode, empty/nested character classes and class set operators are rejected. Shorthand classes have JavaScript semantics in both backends, with Unicode case folding; negated shorthands inside brackets, lookaround, backreferences, Unicode property classes/boundaries, multiline expressions, `\c`/`\0` escapes and escaped surrogate code units are rejected. Literal Unicode, including emoji, remains supported. Nonempty unterminated EOF lines and budget-cut prefixes receive a terminal LF before either engine matches them. Existing line terminators and empty files receive no extra line; the synthetic delimiter does not increase `bytesScanned`. A leading UTF-8 BOM is removed; CRLF, CR and Unicode line separators are normalized consistently before matching. Columns refer to this decoded text. Empty matches occur only at Unicode boundaries. Adjacent empty regex matches follow ripgrep semantics. Node regex work runs in a worker so cancellation cannot be blocked by backtracking; a five-second execution budget terminates pathological expressions with `SEARCH_FAILED`. The worker is disposed after every search. An aborted operation rejects with `ABORTED` and reaps its owned process or worker.

## Watching

`watch({ onChange, onWarning? })` returns an independent subscription with `mode`, `flush()` and async `dispose()`. Each callback receives a sorted batch of `{ path, kind: "created" | "changed" | "deleted" }` relative to the root.

The native backend uses recursive `fs.watch` and a 100 ms coalescing window. It subscribes before the initial snapshot and reconciles notifications against the last visible tree. Multiple notifications for the same path produce one net change per batch. Creating and deleting a file entirely within a window may produce no change. Git index updates/replacements and ignore-rule updates can appear as creation/deletion when a path enters/leaves the visible tree. Linked worktrees also watch their Git-derived external index and exclude directories; those paths never enter callbacks. Deleted directories include deletions for their previously visible descendants.

Snapshots use the same bounded traversal as listing. Scans are serialized and repeat notifications request at most one pending follow-up. A failed scan warns and retains the previous snapshot instead of inventing deletions. `flush()` requests an immediate full reconciliation and awaits delivery, useful before refreshing a listing. `dispose()` cancels owned Git processes, closes every owned native watcher, clears timers, and waits for in-flight work; it is idempotent and no callback follows completion.

Unsupported recursive watching and watcher-limit errors fall back to polling with a clear warning via `onWarning`, or `console.warn` by default. Polling checks every 100 ms and delivers the same coalesced change batches. Both backends keep their subscription alive until disposal. `{ watchMode: "polling" }` forces this backend. Native notifications inspect only affected paths and subtrees. Missing filenames, explicit flushes and ignore-rule changes trigger a full scan. A child index makes directory deletion proportional to the deleted subtree.

## Verification and sources

Tests run once at merge under the owner's current validation policy. The current fix has only static validation; runtime claims need run at merge. The workspace suites are classified in the shared process-test project, including their bulk setup and teardown. `bun run test packages/workspace` runs public API tests with temporary directories, real Git repositories, real ripgrep processes, a real swapping child process, and native filesystem notifications. No provider CLI or recorder is used. Development contract tests require `git` and `rg`; CI installs ripgrep when needed. `bun run check` verifies the whole repository. `bun run --filter @ace/workspace bench` measures a 1,000-file native watch and Node search. `bun run --filter @ace/workspace bench:search` measures both backends on 300 files and 2k/4k/8k/10k occurrences. Neither benchmark gates tests. `{ runtime: { filesystem, spawn, worker, watch, clock } }` injects I/O boundaries; unspecified dependencies use `workspaceRuntime()` defaults. The worker validates both incoming requests and outgoing results with schemas.

The implementation is written fresh from this task and these primary interfaces: [Node filesystem API](https://nodejs.org/api/fs.html), [Node-API](https://nodejs.org/api/n-api.html), [POSIX openat](https://pubs.opengroup.org/onlinepubs/9799919799/functions/open.html), [Node child-process stdio](https://nodejs.org/api/child_process.html#optionsstdio), [Node path API](https://nodejs.org/api/path.html), [Git check-ignore](https://git-scm.com/docs/git-check-ignore), and the installed ripgrep's `rg --help` and JSON output.

Historical measurements from `7c24bbf`, before the current EOF fix: three alternating before/after runs on the same macOS machine gave these medians in milliseconds. The baseline is this PR's reviewed `e83ccf2`, with identical temporary datasets and public calls. The shared machine was running many other worktrees' checks, so absolute times are load-sensitive.

| Dataset                          | rg before | rg after | Node before | Node after |
| -------------------------------- | --------: | -------: | ----------: | ---------: |
| 300 small files, all 300 matches |   15037.6 |   6553.1 |      4060.8 |     4984.6 |
| 2k occurrences, 84 bytes each    |     205.8 |    288.0 |       519.0 |      787.1 |
| 4k occurrences                   |     297.8 |    399.0 |       872.1 |      486.0 |
| 8k occurrences                   |     271.4 |    575.2 |      2747.6 |      799.7 |
| 10k occurrences                  |     353.6 |    954.1 |      4333.0 |      765.1 |

Batching cuts rg's process-per-file cost by 2.3x on the 300-file dataset. The streamed, schema-checked rg representation adds sparse-line processing overhead, but handles dense output before a complete event can exceed its cap. Worker startup/schema loading adds a fixed cost; incremental columns remove growing prefix rescans and make the 10k Node case 5.7x faster. A 1,000-file run reported 1661 ms watch setup, 196 ms delivery including the 100 ms window, 1692 ms full refresh and 957 ms Node search for 100 occurrences. Native ordinary edits reconcile affected subtrees; polling, unknown events, index/ignore invalidation and explicit refreshes need full scans. These are observations, not performance assertions.

The workspace command reader owns bounded byte streams and NUL-framed Git output. Provider-kit's public process API is line-oriented and cannot preserve arbitrary Git filenames or bound a JSON line before its newline, so this service uses a separate short-lived command shell. It never starts provider CLIs.
