# @ace/git

Local Git workspace service for the daemon. No daemon or UI dependencies. Requires Node 24+ and an installed Git 2.40+. It does not contact remotes.

```ts
import { GitError, GitService } from "@ace/git";

const git = new GitService({
  gitBinary: "git", // executable name or absolute path
  timeoutMs: 30_000, // per CLI invocation
  maxPatchBytes: 1024 * 1024,
  now: () => new Date(), // optional clock, also accepts an async clock
  // processRuntime: { spawn, scheduleTimeout, platform }, // optional process boundary
  // tempDirectory: "/existing/temp/root", // optional temporary-index root
});
const checkpoint = await git.createCheckpoint({
  worktree: "/path/to/repository",
  threadId: "thread-123",
  label: "Before turn",
});
const changes = await git.diff({
  worktree: "/path/to/repository",
  from: { kind: "checkpoint", id: checkpoint.id },
  to: { kind: "working-tree" },
});
const { safetyCheckpointId } = await git.restoreCheckpoint({
  worktree: "/path/to/repository",
  checkpoint: checkpoint.id,
});
```

All methods return promises with plain typed results. Failures throw `GitError`, with `code` and `details`. Restore failures after saving a safety checkpoint include `details.safetyCheckpointId`. Filesystem failures use `filesystem_error` and retain the Node error code in `details.errno`. Malformed CLI metadata returns `malformed_output`; schemas validate framing, record lengths, status letters, paths, full SHA-1/SHA-256 hashes and safe nonnegative counts. Missing working directories return `not_a_repo`, separately from a missing executable.

| Method                                                          | Inputs and result                                                                                                                                                                                   |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repositoryInfo(repo)`                                          | Root, branch or detached HEAD, SHA, upstream, ahead/behind and remote URL lists. Unborn HEAD is `null`.                                                                                             |
| `status(worktree)`                                              | `staged`, `unstaged`, `untracked`, `conflicted`. Entries retain both index/worktree codes, submodule state and rename source paths. A path changed in both index and worktree occurs in both lists. |
| `createWorktree({ repo, path, baseRef, branch, reuseBranch? })` | Creates a new branch from the resolved base commit. Explicit reuse checks out the existing branch at its current tip without resetting it. Returns its `Worktree` record.                           |
| `listWorktrees(repo)`                                           | Registered roots, branch/HEAD, locked and prunable reasons.                                                                                                                                         |
| `removeWorktree({ repo, path, force? })`                        | Refuses dirty trees without force, unregistered paths, subdirectories and the main tree. Delegates removal of the registered root to Git. Leaves the branch intact.                                 |
| `pruneWorktrees(repo)`                                          | Removes expired registrations immediately.                                                                                                                                                          |
| `createCheckpoint({ worktree, threadId, label })`               | Returns `{ id, sha, tree, threadId, sequence, label, createdAt }`.                                                                                                                                  |
| `listCheckpoints({ repo, threadId })`                           | Checkpoints in numeric sequence order, visible from any worktree of the repository.                                                                                                                 |
| `deleteCheckpoints({ repo, threadId })`                         | Atomically deletes that thread's refs with compare-and-swap checks. Returns `{ deleted }`. Objects are left for normal Git GC.                                                                      |
| `diff({ worktree, from, to, maxPatchBytes? })`                  | Per-file `{ path, oldPath?, status, additions, deletions, binary }`, `patch` and `truncated`. Sides accept `{ kind: "commit", ref }`, `{ kind: "checkpoint", id }` or `{ kind: "working-tree" }`.   |
| `restoreCheckpoint({ worktree, checkpoint })`                   | Saves the current tree first, restores the requested tree, returns `{ safetyCheckpointId }`.                                                                                                        |

`repo` and `worktree` can name the root or a directory within it. Worktree creation paths resolve against the calling process's current directory. Checkpoint IDs are full refs, `refs/ace/checkpoints/<threadId>/<n>`. Thread IDs accept ASCII letters, digits, underscores and hyphens. Sequence numbers can restart after the thread's refs are deleted. An auxiliary ref at `refs/ace/checkpoint-sequences/<threadId>` points to the latest checkpoint and stores the durable sequence in its commit metadata. Allocation updates both refs atomically, caches the counter in process, and refreshes on compare-and-swap conflicts. Old refs without a counter migrate with a single history scan. Listing batches up to 500 commit reads per process. Thread deletion removes the counter too, leaving objects eligible for Git GC.

Snapshots seed a temporary index from HEAD and the user's tracked index entries, then let Git add the current files and write the tree. This includes staged additions, unresolved conflict contents, force-added ignored files, and changes hidden by index flags. Untracked ignored files are excluded. Git reads all file contents, applies its normal attributes and clean/smudge filters, and records executable bits and symlinks. Parentless commits use ace's local identity and disable signing. The user's index, HEAD, branches and stash are preserved byte for byte.

Live diffs use the same tree snapshot without creating a checkpoint ref. Both live sides in one request share a single snapshot. Metadata uses NUL-delimited Git output, so spaces, tabs, newlines and Unicode paths remain intact. Binary counts are zero with `binary: true`. Git `cat-file --batch` streams changed blobs through a bounded-memory NUL classifier independently of attributes and diff drivers; Git-classified binary files are also retained as binary. When binary and text changes coexist, temporary patch trees contain only changed text entries on both sides, and the result contains binary notices without payloads, including when attributes force text. Files are never read through JavaScript filesystem APIs. Textconv and external diff commands are disabled. Ordering, relative paths, prefixes, quoting, context size and diff algorithm use explicit display settings, so a configured missing `diff.orderFile` cannot break a diff. Patch capture is bounded by bytes, drains the process output, and avoids cutting UTF-8 characters. A truncated patch is for display and may not be applicable. Complete metadata is retained, with a separate 64 MiB guard on CLI metadata output.

Restore uses another temporary index, removes nonignored additions, and restores modified, deleted and renamed files. HEAD, branch and the user's index stay unchanged, so the restored files can appear as changes relative to the existing index. Ignored files are preserved. A collision that would overwrite an ignored file or directory fails with `restore_collision` and retains the safety checkpoint. Git owns path traversal and removal, including symlink handling.

The `processRuntime` boundary can replace the process spawner, deadline scheduler (returning a cancellation function), and host platform. Defaults live in the I/O shell. POSIX timeouts kill the detached process group; Windows uses `taskkill /PID <pid> /T /F` with a bounded helper timeout. Tests exercise both strategies against real parent/descendant processes through an injected Windows executable on macOS; a native Windows run remains outstanding.

All operations serialize within this process by canonical worktree root, across service instances. Restore discovers descendants through the same temporary HEAD/index union as snapshots, so staged parent deletion and ignore rules cannot hide captured children. It acquires their locks before safety capture and retains them until all repositories finish restoring. Safety capture, ignored-file protection and checkout use that same ownership tree. Each repository materializes and removes only its own files through its own Git configuration. Ref creation also uses compare-and-swap allocation for checkpoints from different worktrees or processes. Concurrent allocation during thread deletion fails atomically; callers can retry deletion. The lock does not freeze editors, other processes or other Git clients. The daemon should pause its agents while restoring; an external writer can change files during a snapshot. Restore can fail partway through because of filesystem errors, so the safety ref is the recovery point.

Worktree removal reconstructs the index in a temporary file without `assume-unchanged` or `skip-worktree` flags before checking dirtiness. Hidden edits refuse removal, and the real index remains unchanged.

Bare repositories are unsupported. Sparse checkouts explicitly refuse snapshots, live diffs and restores with `unsupported_repository`; they are not silently captured with absent tracked files omitted. Snapshots flatten initialized submodules and embedded repositories into ordinary checkpoint files, capturing their dirty and untracked contents while preserving nested indexes, HEADs, branches, stashes and administrative files. Git transfers nested objects through a backpressured pack/unpack pipe; no nested ref is created. Restore protects nested ignored files and uses each child repository’s clean/smudge configuration. Uninitialized gitlinks capture existing ordinary files. Sparse nested repositories are also refused; legacy checkpoints containing opaque gitlinks cannot be restored. Empty directories are outside Git's tree model. Invalid UTF-8 path bytes are outside this string-based API.

Run `bun run test packages/git/src` for the real-repository tests. Run `bun run --filter @ace/git benchmark` for a non-gating synthetic 25,000-file benchmark, or `bun run --filter @ace/git benchmark 5000` for a different size. It reports first, unchanged and changed checkpoint times and removes its temporary repository. It never runs a provider CLI. `bun run --filter @ace/git benchmark:history 100` reports early/late allocation averages and listing time for a growing checkpoint history; an optional final module path allows comparison with an earlier version of our service. All benchmarks are non-gating. `bun run --filter @ace/git benchmark:diff 5000` measures a commit diff with one binary and one text change and reports temporary-index bytes; the optional final module path permits an earlier-version comparison. The POSIX resource-quota regression test uses Python 3 to impose an OS file-size limit on Git writes and skips when that host facility is unavailable.

The implementation follows primary Git documentation for [status porcelain v2](https://git-scm.com/docs/git-status), [NUL diff metadata](https://git-scm.com/docs/git-diff), [index plumbing](https://git-scm.com/docs/git-update-index), [tree restore](https://git-scm.com/docs/git-read-tree), [atomic refs](https://git-scm.com/docs/git-update-ref) and [worktrees](https://git-scm.com/docs/git-worktree).

`GitService.init` initializes an unborn repository with an empty commit named
`Initialize ace project`. It uses ace's local author identity and the injected
clock, so creating a project does not require user.name/user.email or signing
configuration. Templates and existing files remain uncommitted. Worktree threads
can start immediately from HEAD. Reinitializing an existing HEAD preserves it;
adding an existing project does not create commits.

Cancellation returns a bounded failure separately from supervised cleanup.
`GitError.cleanup.settled` yields a shared `CleanupResult` from
`@ace/provider-kit/cleanup`. Default POSIX group kills and Windows `taskkill /T`
produce `unconfirmed` receipts because detached writers can escape them.
Worktree mutation scopes remain durably quarantined, including captured children
and worktrees sharing Git metadata. Queued calls reject with `git_quarantined`.
`close()` is bounded and preserves uncertain leases.

Use `mutationState(path)` to inspect quarantine without launching Git. Restart
preserves the fence. `recoverCleanup(path)` uses the host-injected
`processRuntime.cleanupSupervisor` to reconcile every recorded root/descendant
identity. All proofs must confirm cleanup before any intent retires. The default
runtime preserves quarantine when it cannot supply proof. A supervisor must cover
escaped writers; process exit, PID absence and pipe closure are insufficient.
IDs can be injected through `leaseId`, and POSIX signaling through
`processRuntime.signalGroup`. See [ADR 0068](../../docs/adr/0068-git-mutation-cleanup.md)
for persistence, platform policy and host recovery requirements.
