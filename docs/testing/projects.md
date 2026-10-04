# Project management behavior coverage

Mutation cases below are **not executed (tests run at merge)**. The merge-conflict exception
allowed the targeted tests recorded below; remaining tests, including real Git clone progress,
cancellation and process cleanup, need run at merge.

| Test behavior                        | Mutation cases designed to kill                                                                                                                                  |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical idempotent add             | Skip realpath; allocate an id for each alias; lose recent folders.                                                                                               |
| Subfolder root suggestion            | Report the subfolder as repository root; omit branch, default branch or remotes; expose credential-bearing remote URLs; silently register the repo root.         |
| Create plain and Git projects        | Always initialize Git; ignore configured or explicit initial branch; omit the template; overwrite a nonempty folder; reject an existing empty folder.            |
| Traversal and symlink policy         | Normalize traversal before rejecting it; inspect a regular file as a directory; admit symlinks outside allowed roots; create through an escaping parent.         |
| Live removal and rename              | Unregister a working tree without archive; alter execution status while archiving; delete files; lose the registered id on re-add; omit thread metadata updates. |
| Missing project folder               | Require filesystem existence before renaming or unregistering a project whose folder was deleted.                                                                |
| Browse pages and hidden folders      | Remove page bounds; reorder names; skip cursor filtering; expose dot-directories by default; include escaping links; lose repo flags.                            |
| Literal browse names and scan bounds | Trim names or cursors; reject existing trailing punctuation; retain an unbounded directory scan.                                                                 |
| Restart receipts and registration    | Lose unregister markers; reapply an acknowledged add after removal; allocate a new id on re-add; allow new threads against unregistered projects.                |
| Workspace socket pushes and list     | Send only to the acting socket; omit change pushes; include unregistered rows in workspaces.list.                                                                |
| Real Git clone fixture               | Use a shell; fail to clone the bare file fixture through the injected test policy; omit progress; register before success; repeat a completed command.           |
| Production clone URL policy          | Permit file, ext, FTP, git or credential-bearing URLs; accept control bytes; create a destination before rejecting a URL.                                        |
| Clone cancellation                   | Cancel another device's clone; acknowledge before child exit; omit cancellation progress; register a partial clone; repeat a cancelled command.                  |
| Clone reconnect                      | Tie admitted authority to a dead socket; cancel on disconnect; start a second process for an in-flight retry; lose a completed receipt.                          |
| Stalled clone revocation             | Stop checking authority after admission; wait for more progress before killing revoked work; register a revoked clone.                                           |
| Paired project scope                 | Let operate or remote admin imply projects; reject an explicit projects grant; allow a remote desktop ticket; refuse local desktop project reads.                |
| System directory policy              | Let a broad configured root authorize system directories or the filesystem root.                                                                                 |
| In-process client project APIs       | Lose receipt selection ids; miss cross-client pushes; fail to correlate folder-picker reads; lose idempotency or rename/remove behavior.                         |
| Worker APIs and fake catalog         | Fail to forward projects through the worker; derive the catalog only from threads; omit pushes; lose empty projects.                                             |
| Worker clone cancellation            | Complete a clone before delivering progress; fail to forward cancellation; register a cancelled fake clone.                                                      |
| Cancellation during metadata         | Drop the abort check immediately before registration; emit completed after cancellation during post-transfer inspection.                                         |
| Cancellation during final roots      | Drop the final abort check after asynchronous roots validation when no Git children remain to receive cancellation.                                              |
| Cancellation after completion        | Allow cancellation after registration/completed progress but before cleanup and receipt delivery; report cancelled alongside success.                            |
| Shutdown during metadata             | Drain commands before starting Git closure; return before the metadata child exits.                                                                              |
| Creation directory replacement       | Use pathname cwd for Git init; write gitignore through a replaced pathname; register a replaced directory.                                                       |
| Inspection directory replacement     | Register the old inspection path without verifying its pinned identity.                                                                                          |
| Browse directory replacement         | Enumerate through a replaced pathname and expose outside-root folder names.                                                                                      |
| Lightweight inspection               | Reintroduce status/untracked enumeration as a prerequisite for project metadata.                                                                                 |
| Fake destination emptiness           | Reject an existing empty directory; overwrite a Git/template/child-containing directory.                                                                         |
| Project and long-thread coexistence  | Drop either family's protocol union, client methods, worker forwarding or fake command dispatch; stop project pushes after a long-thread request.                |

## Main integration verification

Merged `origin/main` at `98502d93` (#90), retaining both API families and regenerating the protocol
reference. `bun install` rebuilt the native workspace descriptor bridge. Under the explicit
merge-conflict exception, these eight files passed together: **84 tests passed**.

- `packages/client/src/projects.process.test.ts`
- `packages/client/src/long-thread.process.test.ts`
- `packages/client-worker/src/worker-client.test.ts`
- `packages/fake-daemon/src/long-thread.test.ts`
- `packages/protocol/src/wire.test.ts`
- `apps/daemon/src/store.test.ts`
- `apps/daemon/src/projects.process.test.ts`
- `apps/daemon/src/long-thread.process.test.ts`

The client and worker tests exercise project commands and long-thread reads on the same
connection. No full suite, benchmark, mutation run, flakiness run or CI was executed.

The new process-gated regressions are in `apps/daemon/src/projects-races.process.test.ts`.
The cancellation, shutdown, creation and stale-registration regressions were written before
their corresponding fixes. Red/green reproduction and confirmation **need run at merge**.
The native workspace descriptor bridge now supports `mkdirat` and exclusive `openat` writes.
It was rebuilt by the dependency-install step during conflict resolution.

## Performance measurement

`apps/daemon/bench/projects.ts` is a merge-time harness for inspection with 0/1,000/10,000 untracked
files and browsing with 0/100/10,000 folders. It records six warmed samples, median and maximum
latency and peak RSS. **Not executed; needs run at merge.** No benchmark numbers are claimed.
Inspection no longer enumerates status or untracked files. Browse buffers at most 10,000 names
from the pinned descriptor and retains only page+1 metadata results (maximum 101). Each Git
metadata invocation uses a supervised pinned-cwd helper; its process overhead needs measurement.
Rename/archive visit affected threads in pages of 64, with transaction events proportional to
the threads changed. Their workspace-wide atomic transaction remains intentional.

The file-protocol fixture is host-injected at `@ace/git`'s transport boundary. There is no wire input
for a validator or transport allowlist. The cancellation fixture substitutes only the Git process
boundary with a real child that emits progress and waits to be killed. Neither fixture sends a
prompt to a provider CLI.
