# @ace/git

Local Git workspace service for the daemon. No daemon or UI dependencies. Requires Node 24+ and an installed Git 2.40+. It does not contact remotes.

```ts
import { GitError, GitService } from "@ace/git";

const git = new GitService({
  gitBinary: "git", // executable name or absolute path
  timeoutMs: 30_000, // per CLI invocation
  maxPatchBytes: 1024 * 1024,
  now: () => new Date(), // optional clock, also accepts an async clock
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

Live diffs use the same tree snapshot without creating a checkpoint ref. Both live sides in one request share a single snapshot. Metadata uses NUL-delimited Git output, so spaces, tabs, newlines and Unicode paths remain intact. Binary counts are zero with `binary: true`. Git `cat-file --batch` streams changed blobs through a bounded-memory NUL classifier independently of attributes and diff drivers; Git-classified binary files are also retained as binary. Exact binary paths are removed from temporary patch trees on both sides, and the result contains binary notices without payloads, including when attributes force text. Files are never read through JavaScript filesystem APIs. Textconv and external diff commands are disabled. Ordering, relative paths, prefixes, quoting, context size and diff algorithm use explicit display settings, so a configured missing `diff.orderFile` cannot break a diff. Patch capture is bounded by bytes, drains the process output, and avoids cutting UTF-8 characters. A truncated patch is for display and may not be applicable. Complete metadata is retained, with a separate 64 MiB guard on CLI metadata output.

Restore uses another temporary index, removes nonignored additions, and restores modified, deleted and renamed files. HEAD, branch and the user's index stay unchanged, so the restored files can appear as changes relative to the existing index. Ignored files are preserved. A collision that would overwrite an ignored file or directory fails with `restore_collision` and retains the safety checkpoint. Git owns path traversal and removal, including symlink handling.

All operations serialize within this process by canonical worktree root, across service instances. Ref creation also uses compare-and-swap allocation for checkpoints from different worktrees or processes. The lock does not freeze editors, other processes or other Git clients. The daemon should pause its agents while restoring; an external writer can change files during a snapshot. Restore can fail partway through because of filesystem errors, so the safety ref is the recovery point.

Worktree removal reconstructs the index in a temporary file without `assume-unchanged` or `skip-worktree` flags before checking dirtiness. Hidden edits refuse removal, and the real index remains unchanged.

Bare repositories are unsupported. Sparse checkouts explicitly refuse snapshots, live diffs and restores with `unsupported_repository`; they are not silently captured with absent tracked files omitted. Snapshots and live diffs refuse trees containing submodules or embedded repositories with `unsupported_repository`, since a gitlink cannot preserve their dirty contents. Empty directories are outside Git's tree model. Invalid UTF-8 path bytes are outside this string-based API.

Run `bun run test packages/git/src` for the real-repository tests. Run `bun run --filter @ace/git benchmark` for a non-gating synthetic 25,000-file benchmark, or `bun run --filter @ace/git benchmark 5000` for a different size. It reports first, unchanged and changed checkpoint times and removes its temporary repository. It never runs a provider CLI. `bun run --filter @ace/git benchmark:history 100` reports early/late allocation averages and listing time for a growing checkpoint history; an optional final module path allows comparison with an earlier version of our service. Both benchmarks are non-gating.

The implementation follows primary Git documentation for [status porcelain v2](https://git-scm.com/docs/git-status), [NUL diff metadata](https://git-scm.com/docs/git-diff), [index plumbing](https://git-scm.com/docs/git-update-index), [tree restore](https://git-scm.com/docs/git-read-tree), [atomic refs](https://git-scm.com/docs/git-update-ref) and [worktrees](https://git-scm.com/docs/git-worktree).
