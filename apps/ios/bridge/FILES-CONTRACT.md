# Files on the phone: bridge contract

What the SwiftUI Files screens send the bridge and what comes back, for four things: saving a
file or a folder to the phone, sending picked files into a checkout, quick open, and the recent
and open files that stand in for tabs. The older Files requests (tree, read, write, rename, …)
are unchanged and live in `checkout-request.ts`.

Code: `checkout-request.ts` (request schemas), `checkout-files.ts` (requests),
`checkout-downloads.ts`, `checkout-uploads.ts`, `checkout-memory.ts` (actions),
`checkout-actions.ts` (routing). Shared rules come from `@ace/ui-core`
(`checkout-quick-open.ts`, `checkout-transfer-words.ts`), which the web uses too.

Two ways in:

- **Requests** go through the service API, one answer each:
  `aceAction({"type":"service","id":"<id>","request":{"type":"native.files","scope":<Scope>,"operation":<Operation>}})`.
  The answer is the `service.reply` patch for that `id`. Its `value` is `{"ok":true, …fields}`
  or `{"ok":false,"code":"<CODE>","message":"<sentence to show>"}`.
- **Actions** are sent as they are, `aceAction(<Action JSON>)`. They answer with patches, and
  every patch replaces the last one with the same key.

`Scope` is `{"threadId":"…"}` (a thread's checkout) or `{"workspaceId":"…"}` (a project's own
folder before a thread exists, read-only). Paths are relative to the checkout, at most 4096
characters, and folders end in `/` only where noted.

## 1. Saving to the phone (folder download, file share)

### Request `archive`: preview a folder's archive (threads only)

```json
{ "op": "archive", "path": "docs", "includeIgnored": false }
```

`path` is the folder, or `""` for the checkout's root. Reply:

| field       | type   | meaning                                                                                                      |
| ----------- | ------ | ------------------------------------------------------------------------------------------------------------ |
| `previewId` | string | Pass it to the download. It expires after a few minutes, or when the folder changes.                         |
| `entries`   | number | Files and folders that go in.                                                                                |
| `bytes`     | number | Their size before compression.                                                                               |
| `name`      | string | `docs.tar.gz`, or `checkout.tar.gz` for the root.                                                            |
| `summary`   | string | `"12 entries · 4.2 MB before compression"`, ready to show.                                                   |
| `leavesOut` | string | `"Leaves out .git, links and files Git ignores."`, or without the ignored part when `includeIgnored` is set. |

Turning **Include ignored files** on or off asks again with the other value. Each answer has a
new `previewId`.

### Action `files.download`: save to the phone

```json
{ "type": "files.download", "id": "<transfer id ≤64>", "scope": <Scope>, "target": <Target> }
```

`Target` is one of:

- `{"kind":"file","path":"src/app.ts"}`: a checkout file (any scope). There is no size cap, so
  this can replace the old `download` request and its 16 MiB limit for Share.
- `{"kind":"linked","itemId":"…","reference":"…"}`: a file a message links to (threads only),
  replacing the old `linked` request.
- `{"kind":"archive","path":"docs","previewId":"…"}`: the previewed folder (threads only).

Sending the same `id` again while the bridge still holds that transfer does nothing.

Patch, key `files.download:<id>`:

```json
{ "type": "files.download", "id": "…", "name": "docs.tar.gz",
  "phase": "saving" | "saved" | "failed" | "stopped",
  "received": 1234567, "size": 4200000, "filePath": "/…/tmp/ace-downloads/<uuid>/docs.tar.gz",
  "message": "…" }
```

- `received` is the bytes written so far. `size` is known from the start for a `file`. An
  archive only gets a `size` once it is `saved`, so show `received` alone (or a spinner) until
  then.
- `saved` comes with `filePath`, a file in the app's temporary directory. Hand it to the share
  sheet or Save to Files.
- `failed` comes with `message`, the sentence to show. A stale archive preview says "The folder
  changed or this preview expired. Choose Download folder again."
- `stopped` follows a cancel. The partial file is already deleted.

```json
{ "type": "files.download.cancel", "id": "…" }
{ "type": "files.download.done", "id": "…" }
```

Send `done` once the person has shared, saved or dismissed the file. The bridge deletes the
temporary file and sends no more patches for that `id`; drop the row yourself. `done` on a
running transfer stops it first.

## 2. Sending picked files into a checkout (threads only)

Stage each picked document the way message attachments are staged:
`AttachmentStaging().stage(copying:name:mimeType:)` works for Files-app URLs (open them as
security-scoped resources while copying). That gives `localId`, `name`, `bytes` and `sha256`.
The bridge reads the bytes back with the existing `attachment.chunk` host operation, so Swift
needs nothing new here.

### Action `files.upload`

```json
{
  "type": "files.upload",
  "id": "<batch id ≤64>",
  "threadId": "…",
  "folder": "src/assets",
  "files": [
    {
      "localId": "<uuid>",
      "name": "logo.png",
      "mimeType": "image/png",
      "bytes": 48213,
      "sha256": "<64 hex>"
    }
  ]
}
```

`folder` is `""` for the root. A slash at either end is fine. A batch holds 1 to 32 files, sent
one after another; at most 8 batches run at once. The daemon's upload limits apply (the fake
daemon allows 16 MiB in all).

Patch, key `files.upload:<id>`:

```json
{ "type": "files.upload", "id": "…", "threadId": "…", "folder": "src/assets",
  "phase": "sending" | "asking" | "waiting" | "done" | "failed" | "stopped",
  "sent": 30000, "size": 96000,
  "items": [ { "localId": "…", "name": "logo.png", "path": "src/assets/logo.png",
               "size": 48213, "sent": 30000,
               "state": "queued" | "sending" | "conflict" | "waiting" | "done" | "skipped" | "failed" | "stopped",
               "message": "…" } ] }
```

- `asking`: one item is in `conflict`, meaning something already sits at its `path`. Show
  Replace, Keep both and Skip, plus "for all remaining" when more files are left. Answer with:

  ```json
  { "type": "files.upload.resolve", "id": "…", "choice": "replace" | "keepBoth" | "skip", "all": true }
  ```

  With Keep both the file goes in beside the existing one with a number ("notes 2.md"), and
  the item's `path` changes to show it. Replace never overwrites a version newer than the one
  the person saw: if the file changes again before the upload lands, the bridge asks again.

- `waiting`: the connection dropped. The daemon keeps the bytes it already stored, and the
  file continues from there by itself once the connection is back (`upload.resume`). Nothing to
  do; say "Waiting for the connection".
- `failed` items carry `message`, the sentence to show. Files that were already sent stay
  sent.
- `done` means every item is `done` or `skipped`. The tree refreshes from the usual
  `files.changed` patch.

```json
{ "type": "files.upload.cancel", "id": "…" }
{ "type": "files.upload.dismiss", "id": "…" }
```

Cancel stops the current file (the daemon drops its partial upload) and marks the rest
`stopped`; the row stays. Dismiss stops a running batch too, and the bridge forgets it. After
`done`, `stopped` or `dismiss`, Swift may discard the staged copies
(`AttachmentStaging.discard`).

## 3. Quick open

### Request `quick`

```json
{ "op": "quick", "text": "relay/out:42" }
```

Reply: `{ "text", "query", "line"?, "rows": [Row] }`. A trailing `:<n>` is taken off and
returned as `line`, the line to scroll to once the file opens.

`Row`: `{ "path", "name", "folder", "isFolder": false, "positions": [utf16 offsets in path],
"group" }`.

- With a `query`, `rows` are the daemon's best-first matches (the same ranking the web's ⌘P
  uses), files only, all with `group` `"Files"`. Bold the characters at `positions`.
- With nothing typed: up to 8 `"Opened recently"` (this device, newest first), then up to 8
  `"Changed in this checkout"` (git's uncommitted files, without the recent ones and without
  deleted files). A project scope has only the recent files.

Send a new request on each keystroke (debounce about 100 ms) and cancel the previous one with
`{"type":"service.cancel","id":…}`. Show a reply only if its `text` matches the field.

## 4. Recent and open files (in place of tabs)

Kept per thread (or project folder) on this device, between launches, in
`storage.value` key `"files"`. Recents hold 20 files per scope and open files 12, across the
64 most recently used scopes.

Actions (none of them have a reply apart from the patch):

```json
{ "type": "files.memory.watch", "scope": <Scope> }
{ "type": "files.opened",  "scope": <Scope>, "path": "src/app.ts" }
{ "type": "files.closed",  "scope": <Scope>, "path": "src/app.ts" }
{ "type": "files.closed.others", "scope": <Scope>, "keep": "src/app.ts" }
{ "type": "files.moved",   "scope": <Scope>, "from": "src", "to": "lib" }
{ "type": "files.forgot",  "scope": <Scope>, "path": "src/old.ts" }
```

- `watch` when a Files screen appears, to get its lists.
- `opened` whenever a file is shown. It goes first in recents. If it is new to the open list
  it goes last; if it was already open it keeps its place. Past 12 open, the oldest closes.
- `closed` takes a file path, or a folder path ending in `/` to close everything inside it.
  `closed.others` without `keep` closes them all. Closing never touches recents.
- `moved` after a successful rename or move (use the reply's `destination`): entries at or
  inside `from` follow it, order kept.
- `forgot` after a delete: the file is closed and dropped from recents. After Undo, send
  `opened` again if you want it back.

Patch, key `files.memory:<key>`:

```json
{ "type": "files.memory", "key": "thread:<id>" | "project:<id>", "scope": <Scope>,
  "recent": ["src/app.ts", "…"], "open": ["README.md", "src/app.ts"] }
```

Draw `open` as the switcher, in order, and `recent` under it.

## New host operations (Swift: `Sources/Bridge/DownloadFiles.swift`)

All four take JSON `input`, run on the host's serial storage queue, and answer text. They are
declared in `packages/native-host/src/contract.ts`, and `HostServices.perform` routes them to
`DownloadFiles`. `id` is a uuid the script makes for each transfer.

| operation          | input            | body               | Swift does                                                                                                    | answers       |
| ------------------ | ---------------- | ------------------ | ------------------------------------------------------------------------------------------------------------- | ------------- |
| `download.open`    | `{ id, name }`   | none               | Creates `tmp/ace-downloads/<id>/<name>` empty, replacing any earlier one. `name` is cleaned to one file name. | `""`          |
| `download.append`  | `{ id, offset }` | base64 (≤ 128 KiB) | Appends the bytes only when `offset` equals the file's current length; otherwise fails `unsupported`.         | `""`          |
| `download.finish`  | `{ id }`         | none               | Nothing more is written.                                                                                      | absolute path |
| `download.discard` | `{ id }`         | none               | Deletes the folder. A missing one is fine.                                                                    | `""`          |

Bytes cross as base64 text because `call` bodies are strings. Each chunk is at most 64 KiB of
file bytes. Anything left behind goes with the system's temporary-file cleanup.

## Fixture

`ACE_IOS_SPIKE_PORT=9884 bun run spike:daemon` (from `apps/ios`) serves the `ios-files` thread
(`scripts/files-scenario.ts`) with:

- the relay checkout as before (modified, added and deleted files; message links);
- nested folders `docs/guides/setup/` and `docs/guides/reference/`;
- `assets/recordings/`, about 5 MB of noise that doesn't compress, so its archive is about
  5 MB (watch progress, try cancel);
- `uploads/notes.md` already there, so uploading a file named `notes.md` into `uploads/` asks
  Replace, Keep both or Skip;
- `.cache/` as ignored files, which go in only with **Include ignored files**;
- uploads (begin, chunk, resume after a reconnect, commit, cancel) held in memory, 16 MiB in
  all including the seeded files.
