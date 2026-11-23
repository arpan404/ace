# `@ace/git`: observable behaviour and invariants

The contract any implementation of `packages/git` must keep, whichever language runs a part of it,
as of `ace/rust-git-forge` 15ccf65108 (2026-11-23). It covers the package's two entry points
(`.` and `./remote-url`, `packages/git/package.json:6`), the daemon code that calls them, and the
rules each method holds today. Each rule cites the code that holds it. The last section says which
tests guard it and which must pass unchanged on a second implementation.
[ADR 0224](../adr/0224-git-and-forge-move-to-rust-behind-the-same-interfaces.md) decides what moves;
[porting-guide.md](porting-guide.md) is for the builders.

Terms:

- **Root**: the canonical top of a checkout (`Repository.root`, `repository.ts:39`). Every
  method accepts a root or any directory inside it.
- **Protected root**: a checkout the daemon marked with `protectWorktree` (agent worktrees). Git
  runs there with nothing of the repository's that can execute (section 4).
- **Lease**: the on-disk record that a Git writer may be running in a root (ADR 0068,
  `lease-journal.ts:106`). Admission refuses new writers while one is held (section 3).
- **Snapshot**: the tree of everything tracked and nonignored in a checkout, built in a temporary
  index without touching the person's index (`snapshot`, `checkpoints.ts:22`).

## 1. Public surface and its callers

`GitService` (`index.ts:128`) is the surface: 33 daemon modules construct or receive one
(`apps/daemon/src/workspace-runtime.ts:187` builds the daemon's). Results are plain objects of
strings, numbers and booleans; failures throw `GitError` (`types.ts:158`) with a `code`
(`GitErrorCode`, `types.ts:92`) and `details`. Every method returns a promise.

| Group                 | Methods (`index.ts` line)                                                                                                                                                                                                                                                                                                                         | Main callers                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Checkout facts        | `repositoryInfo` :457, `status` :462, `sourceControlState` :316, `sourceControlStatus` :320, `changedFiles` :309, `changeSummary` :331, `checkoutSummary` :335, `projectInfo` :236, `initialBranch` :230, `defaultBranch` :233, `workspaceRevision` :437                                                                                          | `workspace-runtime.ts`, `workspace-refresh.ts`, `project-git.ts`, `projects.ts`                       |
| Refs and branches     | `resolveCommit` :614, `branchHead` :414, `branches` :406, `branchRefs` :410, `switchBranch` :399, `deleteBranch` :520, `remoteDefaultBranch` :427                                                                                                                                                                                                 | `workspace-runtime.ts:785`–`:787`, `pr-head.ts`, `storage/worktree-io.ts`                             |
| Worktrees             | `createWorktree` :491, `setupWorktree` :468, `listWorktrees` :496, `worktreeMetadata` :502, `inspectWorktreeCleanup` :505, `backupWorktree` :508, `cleanupWorktree` :511, `removeWorktree` :515, `pruneWorktrees` :524, `protectWorktree` :148, `forgetWorktree` :152                                                                             | `creation-preparation.ts`, `storage/worktree-executor.ts`, `workspace-move.ts`                        |
| Checkpoints and diffs | `createCheckpoint` :531, `listCheckpoints` :542, `deleteCheckpoints` :549, `restoreCheckpoint` :639, `diff` :557, `diffCommit` :578, `fileLog` :596, `readRevisionLines` :608, `applyPatch` :628                                                                                                                                                  | `run-checkpoints.ts:140`, `:174`; `workspace-runtime.ts:819`–`:870`; `packages/review/src/anchors.ts` |
| Writes                | `commit` :297, `stage` :324, `unstage` :328, `writingContext` :264, `startMerge` :373, `abortMerge` :381, `conflicts` :385, `writeResolution` :389, `takeSide` :392, `commitMerge` :396, `integrate` :256, `forgetIntegrations` :260, `excludeAcePrivate` :452, `replayStackLayers` :354, `continueStackReplay` :357, `restoreStackBranches` :364 | `workspace-runtime.ts`, `forge-stack-sync.ts`                                                         |
| Remotes               | `fetch` :342, `fetchBranch` :423, `fetchPrHead` :430, `push` :338, `pushLeased` :350, `probeRemote` :175, `clone` :219, `init` :225, `publicationInfo` :240, `attachPublicationOrigin` :243, `pushPublication` :246                                                                                                                               | `workspace-push.ts`, `projects.ts`, `repository-publications.ts`                                      |
| Health                | `assertMutationAvailable` :185, `mutationState` :189, `recoverCleanup` :193, `clearStaleLeases` :200, `heal` :207, `healAll` :215, `reviewerHooks` :170, `resourceUsage` :249, `close` :180                                                                                                                                                       | `workspace-runtime.ts:268`–`:356`, `action-errors.ts`, `creation-failure.ts`                          |
| Transfers             | `GitService.transfer` → `GitTransfer` (`transfer-service.ts:31`): `sourceCheckout` :59, `transferOrigin` :63, `checkoutFacts` :67, `captureChanges` :71, bundles :81–:125, `fetchOrigin` :129, `applyChanges` :139, `landingBranch` :142, `checkoutBranch` :148, `fastForward` :157, `addBranchWorktree` :161                                     | `apps/daemon/src/transfers/` (`ports.ts`, `incoming.ts`, `prepare.ts`, `landing.ts`)                  |

Other exports callers use: `GitError`, `gitFailureCodes` (`types.ts:138`), `isMutationUnavailable`
(`types.ts:286`, 5 callers), `WorktreeRemovalRefused` (`worktree-cleanup.ts:15`, 4 callers),
`spawnGitProcess` (`process-runtime.ts:32`, the default spawner and the one tests wrap),
`validateCloneUrl` (`projects.ts:10`), `publicationOriginMatches` (`publication.ts:24`),
`executionKeyQuery` and `nonExecutingEnv` (`non-executing.ts:55`, `:113`, used by
`engine/worktree-title.ts`), `gitAbove` (`transfer-source.ts:17`), `normalizeRemoteUrl` and
`isLocalRemoteKey` (`remote-url.ts:43`, `:138`, also the `./remote-url` entry), and the types
`GitOptions` (`types.ts:57`), `GitProcessRuntime` (`types.ts:28`), `RepositoryInfo` (`:194`),
`Worktree` (`:205`), `DiffResult` (`:247`), `RetiredLease` (`:9`), `ProjectGitPolicy`
(`projects.ts:26`), `StackReplayResult` (`stack-sync.ts:31`), `WorktreeCleanupInput`.

Constructor options (`GitOptions`, `types.ts:57`): `gitBinary`, `timeoutMs` (default 30 s,
`cli.ts:181`, an integer 1 to 2³¹−1), `maxPatchBytes` (default 1 MiB, `index.ts:143`), `now`,
`processRuntime` (spawn, deadline scheduler, platform, group signalling and liveness, Git process
scan, binary location, file clock, optional cleanup supervisor; defaults in `process-runtime.ts:10`),
`tempDirectory`, `leaseWaitMs` (default 60 s, `cli.ts:167`), `leaseId`,
`checkpointCounterCacheSize` (1 to 4096, default 128), `credentialHelperLookup`.

## 2. The process boundary

Every Git operation today is one or more `git` processes (`GitCli.executeRaw`, `cli.ts:706`).

- **Binary.** On macOS the Developer Tools `git` is resolved to its real path so the `xcrun` shim
  isn't paid on every call (`developerToolsGit`, `git-binary.ts:28`). Measured: the shim costs 18 ms a start,
  the real binary 9 ms.
- **Environment.** Inherited, then `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`, and for reads
  `GIT_OPTIONAL_LOCKS=0` so a read never takes `index.lock` or refreshes the person's index
  (`cli.ts:716`–`:719`). Calls under an execution policy also drop `SSH_ASKPASS` and blank
  `GIT_ASKPASS` (`:729`–`:734`). `--no-pager` is always the first argument (`:749`).
- **Process group.** POSIX: each call is a detached group leader (`:740`); a timeout or cancel
  kills the group. Windows: a job object adopts the process; otherwise `taskkill /PID <pid> /T /F`
  with a bounded helper timeout (`process-runtime.ts:90`). Default kills produce `unconfirmed`
  cleanup receipts: a detached writer may survive (README, "Cancellation").
- **Output bounds.** stdout capture defaults to 64 MiB (`cli.ts:765`), past which the call fails
  `output_too_large`, or, for a `stopAtCapture` read, resolves `truncated` after the group is gone
  (`:69`–`:76`). `stopAfterMs` is a read's work budget: it resolves with what was captured
  (`:77`–`:81`). Patches are bounded by `maxPatchBytes`, cut on a UTF-8 boundary, and drained.
- **Deadlines.** `timeoutMs` per call, overridable per call; expiry fails `git_timeout` with the
  arguments in `details` (`cli.ts:920`–`:922`).
- **Cancellation.** An aborted signal before dispatch fails `git_cancelled` without spawning
  (`cli.ts:745`); after dispatch the group is stopped and the call fails `git_cancelled`, with
  `GitError.cleanup.settled` resolving once supervised cleanup is known.
- **Held directories.** Calls given a `directoryFd` run Git in that held descriptor, not by path
  (`repository.ts:113`–`:130`, `:156`–`:176`; `cli.ts:748`–`:756`), so a renamed or replaced path
  can't redirect them.
- **Closed service.** After `close()`, calls fail `git_closed` (`cli.ts:707`).

## 3. Ordering, leases and quarantine (priority 1 and 2)

- **One operation per root at a time**, across every `GitService` in the process: `serial`
  (`repository.ts:39`) keyed by canonical root. Status, writes and snapshots of one root never
  interleave. History reads (`fileLog`, `diffCommit`) don't take the root's lock; at most two run
  at once across the service (`ReadGate(2)`, `index.ts:132`, `read-gate.ts:9`) and a waiter whose
  signal aborts leaves the queue.
- **Writers hold a lease** in the repository's metadata (`<git-dir>/ace-mutation-leases`, or a
  standalone journal, `lease-journal.ts:106`–`:121`) for as long as a killed process may still run
  (`cli.ts:690`–`:703`: the lease is released only after `cleanup.settled`).
- **Quarantine heals itself** (README, ADR 0068): a lease whose process group is gone retires; a
  stopped daemon's lease retires once no Git process works in its checkouts; lock files no live
  Git process holds are removed. Admission waits up to `leaseWaitMs` for a lease that clears, then
  fails `git_quarantined` naming the holder. `heal`/`healAll` run the same checks at startup and in
  sweeps. With a host `cleanupSupervisor`, only its proofs retire intents.
- **Evidence is never assumed.** A platform that can't list Git processes returns `undefined`
  from the scan, and callers treat that as "a writer may be running" (`git-processes.ts:30`–`:33`).
  A Git process this daemon still owns (`runningChildren`, `:39`) is never someone else's writer.

## 4. Nothing of the repository's executes in a protected root

For roots passed to `protectWorktree`, and for the explicit non-executing calls
(`workspaceRevision`), Git runs with command-scope overrides that win over every config file
(`non-executing.ts:35`–`:52`): `core.hooksPath=/dev/null` and every hook event disabled,
`core.fsmonitor=false`, `core.untrackedCache=false`, `core.attributesFile=/dev/null`, `gc.auto=0`,
`maintenance.auto=false`, no signing. Configured filter drivers (`filter.*.clean|smudge|process|
required`) and hooks are found with `executionKeyQuery` (`:55`) and neutralised; transports are
limited to `http`, `https`, `ssh` and `file` (`:53`). Textconv and external diff are always off.
The daemon's worktree naming (`engine/worktree-title.ts`) uses the same `nonExecutingEnv`.

In the person's own (unprotected) checkouts, commits run the person's hooks and signing
(`commitMerge`: "the person's commit (hooks, signing)", `index.ts:395`) and snapshots apply the
person's clean filters (README, "Snapshots").

## 5. Checkout facts

- **Status** is one `git status --porcelain=v2 -z --branch --ahead-behind --no-show-stash
--untracked-files=all --renames --ignore-submodules=none` (`repository.ts:113`–`:131`), parsed by
  `parseStatus` (`parse-status.ts:53`). Entries keep both index and worktree codes, the submodule
  state and rename sources; a path changed in both index and worktree appears in `staged` and in
  `unstaged`. Unborn HEAD is `head: null`.
- **Info** adds the root and remotes; remotes are re-read only when a Git config file the checkout
  uses has changed (`repository.ts:140`, `configFact`).
- **`changeSummary` and `checkoutSummary`** count lines from one status read plus one numstat diff;
  they never snapshot or read untracked contents (`changed-files.ts:284`–`:306`).
  `sourceControlState` lists the first `limit` (500) entries of each section with `truncated`.
- **Background cost.** The daemon's workspace refresh spawns 1.4 Git processes a minute idle for a
  project with six threads, 2.9 with a client viewing an agent thread; a thread's details read
  costs one process for a local thread and two for a worktree thread
  (`apps/daemon/bench/git-spawns.ts`, run 2026-11-23).

## 6. Snapshots, checkpoints, live diffs and restore

- **What a snapshot holds** (README, "Snapshots"): HEAD ∪ the person's tracked index entries ∪
  untracked nonignored files, in a temporary index seeded with no stat data, so `git add` hashes
  every file and a checkpoint holds the bytes on disk, never what a stat cache believes
  (`snapshot-index.ts:9`–`:12`). Staged additions, unresolved conflicts, force-added ignored files
  and changes hidden by `assume-unchanged`/`skip-worktree` are included; untracked ignored files
  are not. Executable bits and symlinks are recorded. Clean filters and attributes apply (in the
  person's roots).
- **Refusals.** Sparse checkouts fail `unsupported_repository` (`snapshot-index.ts:19`–`:26`);
  bare repositories are unsupported; invalid UTF-8 path bytes are outside the API.
- **Nested checkouts** (submodules, embedded repositories) are flattened into ordinary files of the
  checkpoint, with their dirty and untracked contents; nested indexes, HEADs and refs are never
  changed; nested objects travel through a backpressured pack/unpack pipe; no nested ref is
  created. Linked worktrees of the same repository are excluded (`checkpoints.ts:28`–`:62`,
  `nested.ts:48`).
- **The person's index, HEAD, branches and stash stay byte for byte.**
- **Checkpoints** are commits under `refs/ace/checkpoints/<threadId>/<n>`, parentless, with ace's
  identity and the injected clock, signing off. Sequence numbers are allocated with compare-and-swap
  on `refs/ace/checkpoint-sequences/<threadId>` and cached in a bounded LRU (README). Thread ids are
  ASCII letters, digits, `_` and `-`.
- **Where the daemon takes them**: before every send, awaited before delivery
  (`run-checkpoints.ts:166`–`:178`, engine `beforeSend`, `engine/index.ts:298`), and after each turn
  (`:140`). A failure records `checkpoint_failed` or `git_quarantined` on the run and never blocks
  the send.
- **Live diffs** snapshot each live side once per request and diff trees; binary files are found by
  a bounded-memory NUL classifier over `cat-file --batch` (`blob-classifier.ts`) and reported with
  zero counts and `binary: true`; patch trees hold only text entries; metadata has its own 64 MiB
  guard. `paths` limits both sides (rename source included).
- **Restore trusts its safety tree** (`restore.ts:17`–`:30`, `:61`–`:70`): it moves the checkout
  from that tree to the target, so a wrong safety tree loses files.
- **Restore** saves a safety checkpoint first, then restores through another temporary index:
  removes nonignored additions, restores modified, deleted and renamed files, leaves HEAD, branch
  and index unchanged, preserves ignored files and fails `restore_collision` (keeping the safety
  checkpoint) when it would overwrite an ignored path. Restore takes every captured child
  repository's lock before the safety capture and holds them all until the last finishes.

## 7. History reads

`fileLog` follows renames in one bounded walk (`history.ts:111`, `limit`, `maxBytes`,
`budgetMs`); `diffCommit` is one commit's patch for `paths` against its first parent or the empty
tree (`history.ts:164`), failing `shallow_parent` at a shallow boundary and `invalid_argument` for
anything but a full commit id; `readRevisionLines` returns at most 106 lines and 8,192 characters
of an immutable commit or checkpoint (`revision-lines.ts:25`). Patches use explicit display
settings (order, prefixes, quoting, context, algorithm), so a configured missing `diff.orderFile`
cannot break them.

## 8. Worktrees and branches

`createWorktree` creates a new branch at the resolved base commit, or with `reuseBranch` checks out
an existing branch at its tip without resetting it (`worktrees.ts:28`). `removeWorktree` refuses
dirty trees without `force`, unregistered paths, subdirectories and the main tree, and checks
dirtiness in a temporary index without `assume-unchanged`/`skip-worktree` flags, so hidden edits
refuse removal (`worktrees.ts:137`; README). The branch is left. `cleanupWorktree` and
`backupWorktree` keep a recoverable copy before removal; `WorktreeRemovalRefused` says why not.
`branchRefs` lists local branches with upstreams and remote branches without the network
(`remote-branches.ts:34`). Ref names are validated before use (`refSchema`, `decode.ts:24`;
`check-ref-format` in `branchHead`).

## 9. Remotes and credentials (ADR 0002)

ace never collects, stores or proxies credentials. Remote operations run the person's Git with
the person's credential helpers and SSH; ace only chooses which helpers Git may use. Helper names
are read only from the person's system and global files, never from repository config
(`types.ts:58`, `credential-helpers.ts`); repository `core.sshCommand` is not trusted
(`repositorySshCommands`, `credential-helpers.ts:129`). Prompts are off (`GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE` in forge's
runner). Failures map to `auth_failed`, `remote_unreachable`, `remote_ref_not_found`,
`push_rejected`, `protected_branch`, `push_lease_stale` from Git's exit and stderr, which never
leaves the boundary verbatim. `validateCloneUrl` refuses option-like and local-path clone sources.

## 10. Decoding Git's output

Git's output is not provider data: it is validated strictly and a deviation is an error, never
guessed at. Framing, record lengths, status letters, paths (`pathSchema`, `decode.ts:7`: relative,
no `.`, `..` or `.git` part), full SHA-1/SHA-256 ids and safe nonnegative counts are checked; a
failure is `malformed_output` with what was being read (`decode.ts:11`). A missing working
directory is `not_a_repo`, separate from a missing executable (`git_missing`); filesystem failures
are `filesystem_error` with the Node `errno` in `details` (`toGitError`, `types.ts:180`).

## 11. Measured costs (2026-11-23)

From `packages/git/benchmark-ops.ts` on a local clone of this repository (23,528 tracked files,
195.7 MB, 14,669 commits; 12–20 files edited, 5 staged, 10 untracked), Node 26.8.1, M-series Mac
with 16 cores under load 19 to 100; results in `packages/git/ops-benchmark.json`. Wall times are
medians of 10 calls; CPU is per call.

| Call                           | Git processes | Wall    | Inside Git | Daemon CPU | Git CPU  |
| ------------------------------ | ------------- | ------- | ---------- | ---------- | -------- |
| one trivial `git rev-parse`    | 1             | 15 ms   | —          | 1.7 ms     | 9 ms     |
| `status`                       | 1             | 181–216 | 201 ms     | 6 ms       | 293 ms   |
| `checkoutSummary`              | 2             | 253 ms  | 282 ms     | 11 ms      | 389 ms   |
| `listWorktrees`                | 1             | 15 ms   | 4.6 ms     | 4 ms       | 0.4 ms   |
| `branches`                     | 1             | 9 ms    | 8.5 ms     | 3 ms       | 3 ms     |
| `branchRefs`                   | 5             | 17–22   | 29 ms      | 11 ms      | 17 ms    |
| `resolveCommit`, `branchHead`  | 1–2           | 9–28 ms | 6–8 ms     | 4–5 ms     | 0–2 ms   |
| `diff` HEAD → working tree     | 13            | 1,635   | 1,379 ms   | 446 ms     | 1,498 ms |
| `createCheckpoint`             | 11            | 1,649   | 1,405 ms   | 436 ms     | 1,479 ms |
| `workspaceRevision`            | 10            | 1,957   | 1,732 ms   | 440 ms     | 1,951 ms |
| `diffCommit` (one file)        | 4             | 49 ms   | —          | —          | —        |
| `fileLog`, `readRevisionLines` | 2             | 24–78   | 11–73 ms   | 7 ms       | 7–64 ms  |

- A snapshot's Git time is `git add` hashing all 23,528 files (1,148–1,271 ms of it); the rest is
  `ls-files` (109–117 ms), `write-tree` (32 ms), `read-tree`, `update-index`. Hashing the same
  files with one `git hash-object` process took 0.85–2.15 s; eight in parallel took 0.29–0.32 s.
- The daemon's own 310–440 ms CPU per snapshot is mostly the nested-checkout scan's `stat` calls,
  half of them failing and throwing (`candidatePaths`, `nested.ts:65`, and `repositoryPaths`, `:96`; `stat` 276 ms and
  `handleErrorFromBinding` 199 ms over six calls), path decoding and the hash regex
  (`decode.ts:11`, `:109`), `parseIndex` and Zod (profile of six live diffs).
- A process start is 5–10 ms of CPU; for everything but snapshots, status and `branchRefs` it is
  most of the call.
- `gix` 0.91 in process on the same clone: status with untracked files 48–74 ms over two runs
  (Git through `GitService`: 181–216 ms) at about the same CPU, spread over threads;
  `rev-parse HEAD` 0.05 ms, local branches with upstream 0.08 ms, all 460 refs 0.23 ms, worktree
  list under 0.01 ms; blob ids of all 23,527 regular files (raw bytes, no filters) 487 ms on one
  thread, 230 ms on four. Peak RSS of the probe process 50 MB; `git status` 14 MB, the snapshot's
  `git add` 36 MB.

## 12. The tests that guard this, and which carry over

Classes as in [the engine's §19](../engine/behaviour.md): **(a)** behaviour through
`GitService`, `GitTransfer` or the `./remote-url` entry, with real Git in temp repositories
(`test-repo.ts`): must pass unchanged with each switch on; **(b)** a test of a TypeScript
internal: under the full port its module moves too, so its cases move to a `#[cfg(test)]` module
beside the Rust that replaces it and the TypeScript file goes with its module; **(c)** redundant. Counts: 80 files, 380 tests: **(a) 69 files
(325 tests)**, **(b) 11 files (55 tests)**, **(c) none**. The 39 daemon test files that use a real
`GitService` (workspace runtime, checkpoints, transfers, storage) carry over as (a) the same way and
are not listed. All paths in `packages/git/src/`.

| Test files                                                                                                                                                                                                                                                                                                                         | Class | What they guard                                                                                                                                                                                                                                                                | Proof for                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `snapshot-index.process` (18), `checkpoints.process` (11), `checkpoint-bytes.process`, `checkpoint-deadline.process`, `numbering.process`, `workspace-revision.process`, `nested.process`, `nested-linked.process`, `untracked-links.process`, `diff.process`, `diff-resources.process`, `review-regressions.process`              | a     | Section 6: what a snapshot holds (hidden flags, conflicts, force-added ignored files, filters, modes, symlinks), nested flattening, linked worktrees excluded, the person's index untouched, sequence allocation, temporary-index bytes, live diffs and their binary handling. | G5, G6                                                                                                                                                               |
| `audit-restore.process`, `audit-deletion.process`, `audit-ownership.process`, `audit-cli.process`, `credential-restoration.process`                                                                                                                                                                                                | a     | Restore and ownership audits: safety checkpoint, collisions with ignored paths, child locks held across restore, captured children.                                                                                                                                            | G5 (restore's safety capture uses G6 last)                                                                                                                           |
| `repository.process`, `changed-files-regressions.process`, `client-actions.process`, `source-control-ops.process`, `checkout-paths.process`, `malformed.process`, `failure-categories.process`, `cache-lifetime.process`, `cache-races.process`                                                                                    | a     | Sections 5 and 10: status entries (both lists, renames, submodules, unborn HEAD), info and remotes cache, change counts, malformed output and error codes, stage/unstage/commit flows, config-fact caching and races.                                                          | G1, G3a, G4a, G7                                                                                                                                                     |
| `worktrees.process`, `worktree-cleanup.process`, `worktree-recovery.process`, `worktree-progress.process`, `worktree-hooks.process`, `branch-cleanup.process`                                                                                                                                                                      | a     | Section 8: creation and reuse, removal refusals and hidden edits, backup, recovery of missing worktrees, progress, branch cleanup.                                                                                                                                             | G1, G4b                                                                                                                                                              |
| `remote-branches.process`, `remote-default-branch.process`, `push-rejections.process`, `leased-push.process`, `credential-helpers.process`, `transport-config.process`, `system-transport.process`                                                                                                                                 | a     | Section 9: remote branch reads without network, default branch, push refusals, leased pushes, helper sources, transports.                                                                                                                                                      | G1, G2c, G4a, G4c                                                                                                                                                    |
| `stale-leases.process`, `self-healing.process`, `held-directory.process`, `lifecycle.process`, `cleanup-receipts.process`, `escaped-descendants.process`, `timeout-cleanup.process`, `reliability.process`, `read-cancellation.process`, `process-runtime.process`                                                                 | a     | Sections 2 and 3: leases, quarantine and self-healing, held directories, cleanup receipts, escaped descendants, timeouts and cancellation, the process runtime boundary.                                                                                                       | G2a, G2b                                                                                                                                                             |
| `non-executing.process`, `non-executing-hooks.process`, `non-executing-partial-clone.process`, `non-executing-race.process`, `non-executing-submodule.process`, `non-executing-transfers.process`, `person-hooks.process`, `reviewer-hooks.process`, `disabled-hooks.process`, `action-permission.process`, `config-facts.process` | a     | Section 4: nothing executes in a protected root (hooks, filters, fsmonitor, partial-clone fetches, submodules), the person's hooks do run in theirs, reviewer hook decisions, config facts.                                                                                    | G2c, and every write item                                                                                                                                            |
| `merge-conflicts.process`, `integration.process`, `history.process` (14)                                                                                                                                                                                                                                                           | a     | Merges and conflict hunks, integrations, file log and commit diffs. `history.process` also builds a `GitCli` and a `ReadGate` directly for two cases (bounded concurrency); those cases move to G2's Rust tests.                                                               | G3c, G4d                                                                                                                                                             |
| `transfer-bundle.process`, `transfer-capture.process`, `transfer-landing.process`, `transfer-origin-restore.process`, `project-transfer-clone.process`, `transfer-names`, `remote-url`                                                                                                                                             | a     | `GitTransfer`: bundles, captured changes, landing branches, origin restore, clone; landing branch names and remote URL normalisation (pure, through the entry points).                                                                                                         | G3d, G4c, G5 (`captureChanges`)                                                                                                                                      |
| `malformed-output`                                                                                                                                                                                                                                                                                                                 | b     | Strict parsers: `parseStatus`, `parseWorktrees`, `parseDiff`, `parseRemotes`, `parseIndex`, `parseTree`, `parseCommits`, `BlobClassifier` reject malformed framing. The parsers move to Rust with the reads (the CLI stays the executor), and these cases with them.           | moves with G3a, G3b, G5                                                                                                                                              |
| `checkout-facts`, `config-sources`, `conflict-markers`, `diagnostics`, `publication-sensitive`, `read-gate`, `lock-sweep`, `lock-timestamps.process`, `restart-locks.process`                                                                                                                                                      | b     | Pure helpers: subpath tests, watched config sources, conflict marker parsing, stderr diagnostics, publication secret scan, the read gate, lock sweeps and lock-file timestamps.                                                                                                | moves with G2a (`diagnostics`), G2b (`read-gate`, the lock files), G2c (`config-sources`, `checkout-facts`), G3c (`conflict-markers`), G3d (`publication-sensitive`) |
