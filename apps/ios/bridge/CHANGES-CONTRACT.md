# Changes sheet contract

What the phone sends to the bridge for the thread's Changes sheet and the patches the bridge sends back. The bridge side is `changes.ts` (session), `changes-scope.ts` (scopes), `changes-files.ts` (open files and pages), `changes-review.ts` (review), `changes-kept.ts` (kept state), `changes-summary.ts` (list patches) and `changes-actions.ts` (action schemas). Shared rules live in `@ace/ui-core` (`diff-scope.ts`, `mobile-diff-pages.ts`, `review*.ts`).

Actions go in a `{ "type": "sheet", "action": { ... } }` frame, as today. An action the bridge can't parse, or one that names nothing the open sheet holds, answers the usual action error. Patches go through the patch pump: each key holds the latest value, and a cleared key is deleted (the phone drops what it held under that key).

All paths are repository-relative. Long strings are clipped by the bridge's preview at the limits given. Every patch carries `threadId` (string) and `epoch` (number); ignore patches whose epoch isn't the open thread's.

## Actions

### Opening and the list

| kind              | fields                         | effect                                                                                                                                          |
| ----------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `changes`         | `open: boolean`                | Open or close the sheet. Closing clears every `changes:` key.                                                                                   |
| `changes.refresh` | none                           | Read the checkout again (`git.status`, `git.diff`, `pr.status`).                                                                                |
| `changes.scope`   | `scope: string`                | Show `"working-tree"`, `"last"`, `"all"` or a turn's `id` from `summary.scopes`. Files open in the earlier scope that aren't in this one close. |
| `changes.layout`  | `layout: "unified" \| "split"` | Kept on the phone. Every page sent so far goes again in the new layout.                                                                         |

### Files and pages

| kind             | fields                            | effect                                                                                                       |
| ---------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `changes.file`   | `path: string \| null`            | The first sheet's one-file view: closes every open file, then opens `path` (null opens none).                |
| `changes.open`   | `path: string`, `open: boolean`   | Open or close one file among several. Opening past `summary.openLimit` (30) answers an action error.         |
| `changes.expand` | `open: boolean`                   | Expand all: open listed files in order up to `openLimit`. Collapse all: close every open file.               |
| `changes.more`   | `path: string`                    | Send the next page of an open file. A cut file's next daemon page is read first when needed.                 |
| `changes.line`   | `path: string`, `index: number`   | Send one row whole (`changes:line`), for a row whose `clipped` is true. `index` is the row's `i`.            |
| `changes.viewed` | `path: string`, `viewed: boolean` | Mark the file viewed at its current diff version, or clear the mark. Marking closes the file, as on the web. |

### Review (ADR 0038)

Every review action with a `requestId` (1–64 chars) answers once on `changes:notice` with that id. Failures of a send or resolve also show in the draft's own `error` and `state`.

| kind             | fields                                                                                                                                              | effect                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `review.draft`   | `requestId`, `path`, `side: "old" \| "new"`, `start: number`, `end: number`, `text: string` (1–4096), `suggestion?: string` (≤8192), `key?: string` | Save a comment on lines `start..end` (end ≥ start, fewer than 100 lines) of the diff the sheet shows for `path`. The bridge takes the review fingerprint from the rows it holds, so the lines must be in the scope's diff. A cut working-tree file must be open, with the lines loaded. With `key`, edits that unsent draft. A refusal is `ok: false` with the reason in words. |
| `review.discard` | `key`                                                                                                                                               | Delete an unsent or resolved draft. No notice.                                                                                                                                                                                                                                                                                                                                  |
| `review.send`    | `requestId`, `keys?: string[]`                                                                                                                      | Send the named drafts to the agent, or every pending one of this thread when `keys` is absent. Twenty comments go per daemon call.                                                                                                                                                                                                                                              |
| `review.resolve` | `requestId`, `key`, `resolved: boolean`                                                                                                             | Resolve or reopen a sent comment.                                                                                                                                                                                                                                                                                                                                               |
| `review.apply`   | `requestId`, `key`                                                                                                                                  | Apply the comment's suggestion to the checkout (recording it first if unsent), then resolve it. The checkout is read again afterwards.                                                                                                                                                                                                                                          |
| `review.reply`   | `requestId`, `key`, `text` (1–4096)                                                                                                                 | Reply under a sent comment, then send its replies on `changes:replies`.                                                                                                                                                                                                                                                                                                         |
| `review.replies` | `key`                                                                                                                                               | Read a comment's replies into `changes:replies`. No notice.                                                                                                                                                                                                                                                                                                                     |
| `review.status`  | `requestId`, `status: "approved" \| "changes-requested"`                                                                                            | Set the newest review's status. Opens a working-tree review when there is none.                                                                                                                                                                                                                                                                                                 |
| `review.refresh` | none                                                                                                                                                | Read the daemon's reviews for this thread, so comments from other devices appear. This also runs when the sheet opens.                                                                                                                                                                                                                                                          |

## Patches

### `changes:summary` → `type: "changes.summary"`

The scope's file list, what is open, and the next git step. Existing fields keep their meaning; new fields are marked _new_.

| field                               | type                                                                        | meaning                                                                                                                                                                                                               |
| ----------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state`                             | `"loading" \| "ready" \| "error"`                                           | The listed scope's state. Turn scopes are always `ready`; the working tree follows its daemon read.                                                                                                                   |
| `message`                           | string                                                                      | Refusal code when `state` is `error` (the shared copy table words it).                                                                                                                                                |
| `scope` _new_                       | `{ id: string, label: string, turn: number \| null, workingTree: boolean }` | The scope shown, after resolving: `"last"` stays `"last"`, and a turn that no longer exists falls back to the last turn. `turn` is the shown turn's number (for `last` too).                                          |
| `scopes` _new_                      | `{ id: string, label: string, turn: number \| null }[]`                     | The menu. Always `{ id: "working-tree", label: "Uncommitted" }`. Once a turn edited files, it also has `last` ("Last turn"), `all` ("This thread") and each edited turn (`label: "Turn N"`, `turn: N`, `id`: run id). |
| `files`                             | `FileRow[]`                                                                 | At most 200, in the scope's order (the checkout's status order, or first-touched for turns).                                                                                                                          |
| `hidden`                            | number                                                                      | Files beyond the 200.                                                                                                                                                                                                 |
| `partial`                           | boolean                                                                     | Working tree: the daemon reported more files than one read returns. Turn scopes: some row isn't counted yet.                                                                                                          |
| `totals`                            | `{ files, additions, deletions }`                                           | Over the whole scope (counted rows only, for turns).                                                                                                                                                                  |
| `patchTruncated`                    | boolean                                                                     | Working tree only: the checkout's 256 KiB patch was cut. Cut files are now read alone, so this is informational. Always false for turn scopes.                                                                        |
| `open` _new_                        | string[]                                                                    | Paths open now, in opening order.                                                                                                                                                                                     |
| `openLimit` _new_                   | number                                                                      | Most files open at once (30).                                                                                                                                                                                         |
| `layout` _new_                      | `"unified" \| "split"`                                                      | Kept layout.                                                                                                                                                                                                          |
| `branch`, `step`, `busy`, `methods` | as before                                                                   | The checkout's next git step, whatever scope the list shows.                                                                                                                                                          |

`FileRow`:

| field                    | type                                                             | meaning                                                                                                                                                                          |
| ------------------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`                   | string (≤1024)                                                   |                                                                                                                                                                                  |
| `from`                   | string \| null                                                   | A rename's old path.                                                                                                                                                             |
| `status`                 | `"added" \| "modified" \| "deleted" \| "renamed" \| "untracked"` |                                                                                                                                                                                  |
| `additions`, `deletions` | number                                                           | 0 while `counted` is false.                                                                                                                                                      |
| `binary`                 | boolean                                                          |                                                                                                                                                                                  |
| `counted` _new_          | boolean                                                          | False for a turn file whose text edits aren't diffed yet. It turns true once the file has been opened, since diffing runs only for open files. Always true for the working tree. |
| `viewed` _new_           | boolean                                                          | Marked viewed at this exact diff version. A changed diff clears it.                                                                                                              |
| `open` _new_             | boolean                                                          | The file is open.                                                                                                                                                                |

### `changes:tree` → `type: "changes.tree"` _new_

The listed files (the same ≤200) as folder rows, every folder open. The phone collapses folders itself by hiding rows deeper than a collapsed folder's `depth` that follow it. `scope` is the shown scope id. `rows` is an array of:

- `{ kind: "folder", key, name, depth, additions, deletions, files }`. `key` is the folder path. It is also the collapse key. `name` is one segment, or a chain of single-child folders joined (`"server/src"`). `files` counts the files at any depth below it.
- `{ kind: "file", key, name, depth, additions, deletions, index }`. `key` is the file's path. `index` is its position in `summary.files`.

Folders come before files at each level, and each group is sorted by name with numbers ordered numerically.

### `changes:file:<id>` → `type: "changes.file"` (changed)

One header per open file. The key used to be the single `changes:file`. It is now `changes:file:<id>`, where `id` is the bridge's fixed-width file id (`f00001`, …), stable for a path while the sheet is open. Closing a file clears its header and its pages. The old `diff` field is gone: rows come in pages.

| field       | type                              | meaning                                                                                                                                        |
| ----------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `file`      | string                            | The id; pages use the same one.                                                                                                                |
| `path`      | string                            |                                                                                                                                                |
| `version`   | string                            | The diff version (see Viewed marks). A new version means the file starts again: its pages are cleared and page 0 comes again.                  |
| `state`     | `"loading" \| "ready" \| "error"` | `loading` while a cut file's first daemon page is being read.                                                                                  |
| `message`   | string                            | Error code (`not_in_scope`, a workspace refusal code, `unavailable`).                                                                          |
| `binary`    | boolean                           | Git shows no text; there are no rows.                                                                                                          |
| `pages`     | number                            | Pages sent so far: keys `changes:page:<id>:0 … pages-1`.                                                                                       |
| `rows`      | number                            | Rows the bridge holds for the file so far.                                                                                                     |
| `remaining` | number \| null                    | Rows not yet sent. Null while the file isn't fully read from the daemon (more may come).                                                       |
| `complete`  | boolean                           | Every row of the file is known.                                                                                                                |
| `cut`       | boolean                           | The daemon's pages stopped before the file's end: past 16 MiB held, or past the daemon's 32 Mi offset limit. The rest is only on the computer. |
| `empty`     | boolean                           | Complete and no line rows: a mode change, an empty file.                                                                                       |
| `viewed`    | boolean                           | As the summary row.                                                                                                                            |

Show "Show more" while `remaining !== 0`, then send `changes.more`. When `remaining` is null and no page arrives yet, the next daemon page is being read.

### `changes:page:<id>:<index>` → `type: "changes.page"` _new_

Fields: `file`, `path`, `version` and `index` (0-based). `layout` is `"unified"` or `"split"`, plus one of:

- `lines: Row[]` when `layout` is unified;
- `pairs: Pair[]` when `layout` is split.

A page holds about 300 rows. A run of removed and added lines that would be split runs on, up to 200 more rows. Concatenate pages in `index` order. A page's rows never change once sent for a given `version`, but its layout does when the person switches layout (the same key arrives again with the other field).

`Row`:

| field        | type                                    | meaning                                                                                                                                                                        |
| ------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `i`          | number                                  | The row's index in the file. Rows go 0, 1, 2… across pages. `changes.line` uses it.                                                                                            |
| `kind`       | `"add" \| "del" \| "context" \| "fold"` | `fold` replaces the old `hunk` rows: unchanged lines not shown between hunks.                                                                                                  |
| `old`, `new` | number \| null                          | Line numbers on each side; null on the side a line doesn't exist (and on folds). Comment on `new` numbers for added and context lines, and on `old` numbers for removed lines. |
| `text`       | string                                  | The line without its `+`/`-`/space marker, clipped to 2,000 UTF-16 code units. `""` for folds.                                                                                 |
| `length`     | number                                  | The whole line's length.                                                                                                                                                       |
| `clipped`    | boolean                                 | `text` is shorter than the line. Offer "Show whole line" (`changes.line`).                                                                                                     |
| `count`      | number \| null                          | A fold's unchanged line count, null when unknown. Null for other kinds.                                                                                                        |

`Pair` is `{ kind: "fold", fold: Row }` or `{ kind: "pair", left: Row | null, right: Row | null }`. Removed lines pair with the added lines that follow them, row by row. Context rows appear on both sides with the same `i`. This is the web's split pairing (`pairRows`).

### `changes:line` → `type: "changes.line"` _new_

One whole row: `file`, `path`, `version` and `row: Row`. The row's `text` is up to 100,000 code units; `clipped` stays true past that. There is one key, so the latest request wins.

### `changes:review` → `type: "changes.review"` _new_

| field        | type                                                                          | meaning                                         |
| ------------ | ----------------------------------------------------------------------------- | ----------------------------------------------- |
| `session`    | `{ id: string, status: "open" \| "changes-requested" \| "approved" } \| null` | The thread's newest review on the daemon.       |
| `refreshing` | boolean                                                                       | A `review.refresh` is running.                  |
| `message`    | string                                                                        | The last refresh's failure in words, else `""`. |
| `pending`    | number                                                                        | Drafts still to send (`draft` or `failed`).     |
| `open`       | number                                                                        | Sent and unresolved (`sent` or `resolving`).    |
| `resolved`   | number                                                                        |                                                 |
| `hidden`     | number                                                                        | Drafts past the 200 listed.                     |
| `drafts`     | `Draft[]`                                                                     | This thread's drafts, newest first.             |

`Draft`:

| field          | type                                                                      | meaning                                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`          | string                                                                    | Names the draft in review actions.                                                                                                                                                              |
| `path`         | string                                                                    |                                                                                                                                                                                                 |
| `side`         | `"old" \| "new"`                                                          |                                                                                                                                                                                                 |
| `start`, `end` | number                                                                    | Lines covered (`end === start` for one line).                                                                                                                                                   |
| `text`         | string (≤4096)                                                            |                                                                                                                                                                                                 |
| `suggestion`   | string \| null (≤8192)                                                    | Replacement text for the lines. `""` deletes them.                                                                                                                                              |
| `state`        | `"draft" \| "sending" \| "sent" \| "failed" \| "resolving" \| "resolved"` | `draft` → Send → `sending` → `sent` → Resolve → `resolved`. A failed send is `failed` (Retry sends again). A send or resolve in flight when the app went away comes back as `failed` or `sent`. |
| `error`        | string \| null                                                            | Why the last send, resolve or apply failed.                                                                                                                                                     |
| `anchor`       | `"active" \| "outdated" \| "addressed-pending-review" \| null`            | The daemon's view of the comment's lines, once read back.                                                                                                                                       |
| `applied`      | boolean                                                                   | The suggestion was applied.                                                                                                                                                                     |
| `sent`         | boolean                                                                   | The daemon has recorded it, so replies are possible. Comments from other devices arrive with `sent: true`.                                                                                      |
| `createdAt`    | number                                                                    | ms since epoch; for comments from other devices, when their review opened.                                                                                                                      |

### `changes:replies` → `type: "changes.replies"` _new_

One comment's replies at a time: `key`, `state` (`"loading" | "ready" | "error"`), `message`, and `replies: { id, text }[]`, oldest first.

### `changes:notice` → `type: "changes.notice"` _new_

A review action finished: `requestId`, `action` (the action's kind), `ok` (boolean), and `message` (`""` when ok, else the reason in words, ≤512 chars).

### Unchanged

`git:<requestId>` (git action results) and the git draft patches keep their contract (`git-actions.ts`, `git-drafts.ts`).

## Viewed marks, layout and drafts on the phone

The bridge keeps all three in the `review` kept value (`storage.value.*`, one JSON value, 1 MiB host cap): `{ v: 1, drafts, viewed, layout }`.

- **Drafts:** at most 400, newest first. When the value would not fit, resolved drafts go first, then the oldest.
- **Viewed:** per thread, a map from path to version, bounded to the 64 most recent threads and 500 files each, as on the web.
  - In the working tree, the version is a hash of the file's whole patch section. For a file cut from the checkout's patch, it is built from the status counts plus a hash of the part read.
  - In turn scopes, the version is the web's `fileDiffKey`, which changes when any of the file's changes does.
- **Layout:** the diff layout, `"unified"` or `"split"`.

The value is read once when the bridge starts a Changes session. Drafts written before the read finishes are kept.

## Daemon `git.diff` paging

`git.diff` with no new fields reads the whole checkout as before (≤256 KiB, `truncated`). It now also takes:

- `path` (one file, a safe repository-relative path);
- `from` (a rename's old path);
- `offset` (UTF-16 code units into that file's patch, ≤32 Mi).

It answers that file's patch from `offset`, at most 262,144 code units, ending on a line break where possible. `truncated: true` with `nextOffset` means more follows. `truncated: true` without `nextOffset` means the rest is past the limit. The phone never calls this itself; the bridge does, for files the whole-checkout read cut.

## Fixture

`ACE_IOS_SPIKE_PORT=9884 bun run spike:daemon` (in `apps/ios`) seeds:

- **`ios-changes`**, "Cap the replay window" (branch `feat/replay-window`, codex). Seeded in `scripts/changes-scenario.ts`.
  - Three root turns, each editing files with full before and after text:
    - Turn 1: `apps/server/src/replay/window.ts` updated, `cursor.ts` added.
    - Turn 2: `window.ts` again, `packages/protocol/src/replay.ts` updated.
    - Turn 3: `window.test.ts` added, `legacy.ts` deleted.
  - The scope menu shows Uncommitted, Last turn, This thread, and Turns 1–3. The sheet opens on Last turn.
  - Uncommitted lists 44 files: the five above, 38 small files across nested folders (`apps/server/src/replay/cache`, `…/cursor`, `apps/server/src/sockets`, `apps/web/src/features/thread/replay`, `packages/client/src/replay`, `packages/protocol/src/replay/v2`, `docs/adr`), and `data/fixtures/replay-events.jsonl` with 22,000 added lines. That file sorts last, so the checkout's patch is cut inside it and the file is read alone in daemon pages.
  - The checkout holds each changed file's new text, so comments are checked against it and suggestions apply. Review commands run on the fake daemon's in-memory review desk.
- **`ios-tree`**, "Review PID-reuse safety". The earlier sheet fixture, unchanged: three uncommitted files, including a 3,000-line one and a long line.
