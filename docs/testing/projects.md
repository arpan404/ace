# Project management behavior coverage

All tests and mutation cases below are **not executed (tests run at merge)**.
Runtime behavior, including real Git progress, process cleanup and socket delivery, needs run at merge.
Static verification does not establish those outcomes.

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

The file-protocol fixture is host-injected at `@ace/git`'s transport boundary. There is no wire input
for a validator or transport allowlist. The cancellation fixture substitutes only the Git process
boundary with a real child that emits progress and waits to be killed. Neither fixture sends a
prompt to a provider CLI.
