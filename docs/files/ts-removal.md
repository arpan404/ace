# TypeScript file listing, watching, searching and path-index users

Inventory for wave 3 of ADR 0178: every importer of the TypeScript code `ace-files` replaces,
the feature it serves, and where that feature moves. Grepped over `apps/` and `packages/`.

## `packages/workspace`

| Importer                                                                          | Feature                                                                                                                                                             | Replacement                                                                                                                           |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/files/src/breadth-list.ts` (`listWorkspace`, `GitIgnore.scan`)          | The legacy `list` file operation: the Files panel's checkout tree and the agent-facing workspace listing for shipped clients. Breadth-first, capped at 1,000 paths. | ace-files' paged `list` through `FilesTool.listFolder`, composed breadth-first in the daemon for the legacy `list` reply.             |
| `apps/daemon/src/automation-workspace.ts` (`createWorkspace(...).watch`)          | Automation file triggers (`trigger.kind === "file"`).                                                                                                               | `FilesTool.watch` over the checkout's ace-files watch, mapping `changes`/`rescan`/`warning` to the automation event shape.            |
| `packages/context/src/folder-index.ts` (`GitIgnore`, `SafeRoot`, `walkWorkspace`) | Ordinary-folder path inventory for context quick open.                                                                                                              | Deleted: quick open and folder mentions are answered by ace-files.                                                                    |
| `packages/files/src/filesystem.ts` (`walkWorkspace`)                              | `tree:` folder version digest (`observed`, upload commit checks).                                                                                                   | Kept: a version digest is not a listing feature; ace-files' `describe` serves the checkout and this stays for the local port.         |
| `packages/files/src/local-io.ts` (`walkWorkspace`)                                | The local `FilesIo` port's `walk`/`measure`: archive packing, upload staging, and tests of non-checkout roots.                                                      | Kept: the daemon's checkout port is `aceFilesIo`, which pages ace-files' `list`; the local port only serves artifact roots and tests. |
| `packages/files/src/uploads.ts` (`walkWorkspace`)                                 | Finds stale partial upload files beside a target folder.                                                                                                            | Kept: not a checkout listing; it scans one folder's upload temporaries.                                                               |
| `packages/workspace` benches and tests                                            | List, search, watch, read through `createWorkspace`.                                                                                                                | Deleted with `createWorkspace`; ace-files carries the replacement benches in `native/files`.                                          |

`createWorkspace(...).search` has no production importer: only `packages/workspace`'s own tests
and benches. It is deleted. `createWorkspace(...).list` and `.read` likewise have no production
importer outside the legacy `list` operation above.

`SafeRoot` and `GitIgnore` stay: `packages/files` uses them for confined I/O, the local port, the
tree digest and gitignore marking. `walkWorkspace` stays only for those users; the checkout walk
in production goes through `aceFilesIo` (ace-files' paged `list`).

## `packages/files/src/breadth-list.ts`

Only `FilesService.performRequest` for `operation.op === "list"` uses `breadthFirstPaths`. The
legacy operation stays for shipped clients and is answered from ace-files' paged listing
(breadth-first, first 1,000 paths, as before), through a `paths` method on the `FilesIo` port.
The module is deleted; its ordering and ignore rules stay guarded by
`packages/files/src/list-order.process.test.ts` and the daemon's real-binary list test.

## `packages/context`

| Importer                                                                                  | Feature                                                                                          | Replacement                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/context/src/git-workspace.ts` (`PathIndex`, `folderIndex`, `updateFolderIndex`) | `mention.complete` (`@` menu and quick open), folder mentions, index refresh from watcher hints. | `mention.complete` asks ace-files' `indexQuery` through an injected `complete` hook; folder mentions list through an injected ace-files `listFolder` hook. The Git index, its watcher cache and their refresh code are deleted. |
| `packages/context/src/workspace-cache.ts` (`PathIndex` bytes, watcher, retries)           | Retained index budget and recovery for the above.                                                | Deleted; `ContextService` keeps only confined readers per root.                                                                                                                                                                 |
| `packages/context/src/folder-index.ts` (`PathIndex`, `updateFolderIndex`)                 | Ordinary (non-Git) folders' inventory.                                                           | Deleted; ace-files indexes every checkout, Git or not.                                                                                                                                                                          |
| `packages/context/src/path-index.ts` (`PathIndex`)                                        | Fuzzy completion, subtree enumeration and quota.                                                 | Deleted; ace-files' `files-index` owns ranking, and `folderListing` consumes ace-files' paged listing.                                                                                                                          |
| `packages/context/src/service.ts` (`mention.complete`, `draft.mention.complete`)          | Quick open for a thread and for a New-thread draft.                                              | Both ask ace-files through `ContextServiceOptions.complete`; a not-yet-built index answers `ready: false` and clients keep their loading state.                                                                                 |

Mention resolution (`mention.resolve`, `compose`) keeps `GitWorkspace` for one file's
confinement, gitignore check and bytes. That is not listing, watching, searching or a path index.

## Daemon glue

- `apps/daemon/src/files-tool/quick-open.ts` and `services/context.ts`'s `nativeQuickOpen`:
  the TypeScript fallback for `mention.complete`. Deleted; `ContextService` calls the ace-files
  hook itself, so the local socket and the relay get the same answer.
- `apps/daemon/src/services/relay-channel.ts`'s `quickOpenResult`: same fallback over the relay.
  Deleted for the same reason.
- `apps/daemon/src/services/context-session.test.ts`: asserts the removed interception's
  revoke/disconnect behaviour; the access re-check moves into `ContextService`.
- `apps/daemon/src/automation-workspace.ts`: moves from `createWorkspace(...).watch` to
  `FilesTool.watch`.

## Clients

Quick open keeps its request shape. A completion answer gains `ready: boolean` (absent means
ready, for older daemons): `false` while ace-files builds its index, so `apps/web` and the iOS
Files screen keep their existing loading state instead of showing "no matches". No client uses
the TypeScript index directly.
