# Porting `@ace/git` to Rust

For the builders of [ADR 0224](../adr/0224-git-and-forge-move-to-rust-behind-the-same-interfaces.md),
one work item each. Read the ADR and [behaviour.md](behaviour.md) first: the contract there is
what you keep, and behaviour.md §12 lists every test file by class. Where this guide is silent,
follow [the engine's porting guide](../engine/porting-guide.md); its rules 6 (idiomatic, safe
Rust), 7 (bindings only translate), 9 (inject what you can't control), 11 (no provider CLIs), 12
(build and check) and 13 (commit and push) apply word for word.

Branch from `ace/rust-git-forge` once G0 has landed on it, one branch per work item
(`ace/rust-git-<item>`). G2 and later need ADR 0223's E2 (`ace-supervisor`) on the branch.

## Rules for every work item

1. **Same TypeScript interface.** `GitService`, `GitTransfer`, every export of `.` and
   `./remote-url`, `GitError` (with `code`, `details`, `cleanup.settled`) and
   `WorktreeRemovalRefused` keep their signatures, results, codes and timing. What is synchronous
   stays synchronous (`protectWorktree`, `forgetWorktree`, `mutationState`). The binding throws the
   TypeScript error classes, so `instanceof` holds.
2. **One switch, one line.** G0 makes the exported `GitService` choose its backend per instance
   from `ACE_GIT` (`packages/provider-kit/src/native-switches.ts`) and puts one `if` at each
   method that dispatches to the native core when the method's part is on. You edit only your
   files (table below). With the switch on and the addon missing, fail at startup; never fall back
   for that.
3. **The Git CLI stays the executor.** You port what TypeScript does around Git (ordering, leases,
   environment, parsing, errors), not what Git does: every command, argument, order and
   environment of today's TypeScript is kept, run through `ace-supervisor`. `gix` only in G1, G6
   and G7, and only for what the ADR lists.
4. **Ports stay ports.** Every `GitProcessRuntime` member (`types.ts:28`) is a port of the core.
   An injected one is called back on the JS thread through G0's bridge; an injected `spawn`'s
   `ChildProcess` is read through the bridge as a supervised child is. Never skip an injected port
   and never use the default when one is injected: 25 test files depend on it (ADR 0224 fact 7).
5. **Held directories.** A call with `directoryFd` spawns Git in that descriptor (G2a). Until the
   supervisor supports it, the shell sends such calls to the TypeScript backend. `gix` never opens
   a held directory.
6. **Fall back, never guess.** A `gix` step (G1, G6, G7) reads its preconditions first and returns
   a fallback reason for anything outside what it reproduces exactly; the core then runs the CLI
   step in the same `serial` turn and lease. A fallback is counted in
   `resourceUsage().nativeFallbacks[reason]` and logged (rule 11), never an error, never a partial
   result. When in doubt, fall back.
7. **Output through `ace-json`.** Results are Rust structs in the TypeScript's field order,
   serialized with `ace_json::ser::to_string`; the shell parses once. Git's bytes become strings
   as `Buffer.prototype.toString("utf8")` makes them (`String::from_utf8_lossy` has the same
   replacement rule), then go through the Rust ports of today's schemas (`decode.ts`:
   `pathSchema`, `refSchema`, `hashSchema`, `modeSchema`), which reject exactly what they reject.
   Strings a caller passed in are `JsString`. No `serde_json`.
8. **Same numbers.** 30 s default deadline, 64 MiB metadata capture, 1 MiB default patch, 8 MiB
   branch listings, `ReadGate(2)`, 60 s lease wait, 128 checkpoint counters (1 to 4,096),
   500-entry sections, 106 lines and 8,192 characters of revision lines, 64 KiB `applyPatch`.
9. **Tests.** The class (a) files of your item are the proof; you don't edit them. Run each
   alone, switch on and off; `test -f` first, since an empty path runs the whole suite.

   ```sh
   f=packages/git/src/stale-leases.process.test.ts
   test -f "$f" && ACE_SUPERVISOR=native ACE_GIT=core bun --bun x vitest run "$f" --maxWorkers=4
   test -f "$f" && bun --bun x vitest run "$f" --maxWorkers=4
   ```

   Never run the full suite, `bun run test`, `bun run check`, or `test:process`, `test:slow`,
   `test:changed`. One file at a time.

10. **(b) cases move with their module.** Each (b) file named in your item becomes a
    `#[cfg(test)] mod tests` beside the Rust that replaces its module: same inputs, same
    expectations, none added or dropped. The TypeScript test goes when its module goes (after
    default-on), not in your item. New Rust tests only for behaviour nothing covers (the fallback
    triggers), and the commit says which.
11. **Gates** (ADR 0224 §7). Every item runs its cross list both ways
    (`bun scripts/native-cross.ts ACE_GIT <file>`); write items (G4, G5) also run
    `bun scripts/native-git-digest.ts <file>` on every file of their proof list and pass only
    with identical state digests (raw index, HEAD and ref bytes where preservation is promised)
    and identical completion records compared by value (messages, every `details` value such as
    `safetyCheckpointId`, after id mapping), and every write's postconditions met; G6 and G7 run
    their files with `ACE_GIT_VERIFY=strict`. A gate fails on: a test where an operation selected
    native and that operation never completed natively (another operation's completion doesn't
    count); a fallback your item doesn't list for that test and operation (reason and count), or a
    listed one that didn't occur; in cross files, a producer → consumer edge the file exercises
    (derived from its switch-off run) without both backend directions over the two runs; under
    strict, a snapshot test none of whose equal verdicts had a Rust-hashed row.
12. **Never touch the person's repositories.** Tests use `test-repo.ts`'s temp repositories;
    benches clone with `git clone --local` into a temp directory (`benchmark-ops.ts`). Shadow
    measurement (G6) runs on read-only local clones of this repository and the main checkout.
13. **Measure before you finish**, both ways, and report both:
    `node packages/git/benchmark-ops.ts . --calls=10 --only=<your calls>`, then with the switch.
14. **Supply chain.** `gix` with `default-features = false` and only the ADR's features; never
    `pack-cache-lru-static`. `deny.toml` bans `uluru`; run `cargo deny check` in `native/daemon`
    after any dependency or feature change (Cargo unifies features across the workspace).

## Files per work item

G0 creates every file below as a stub and declares every module. Rust in
`native/daemon/crates/ace-git/src/`, bindings in `native/daemon/crates/ace-daemon-node/src/git/`,
shells in `packages/git/src/`. `index.ts` stays the TypeScript surface; `GitService`'s methods
dispatch to the shells.

| Item | TypeScript replaced (`packages/git/src/`)                                                                                                                                                                                                                                           | Rust (yours)                                                                     | Binding                | Shell                   | Part            |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------- | ----------------------- | --------------- |
| G1   | the ref reads of `repository` (`commit` :156, `worktrees` :90), `remote-branches` (`branchRefs` :34, `branchHead` :150, the listing :76–:115), `actions` `listBranches` :274                                                                                                        | `refs.rs`, `worktrees_gix.rs`                                                    | `refs.rs`              | `native-refs.ts`        | `refs`          |
| G2a  | `cli`, `process-runtime`, `git-binary`, `deadlines`, `failure-text`, `diagnostics`, `pinned-process`, `git-job`                                                                                                                                                                     | `core/{cli,spawn,deadline,failure,diagnostics,job}.rs`                           | `core.rs`, `bridge.rs` | `native-core.ts`        | `core`          |
| G2b  | `lock`, `read-gate`, `repository` (root, `serial`), `repository-paths`, `directory-lease`, `lease-admission`, `lease-journal`, `lease-owner`, `lease-roots`, `mutation-leases`, `mutation-state`, `git-locks`, `git-processes`, `git-process-facts`                                 | `core/{serial,read_gate,paths}.rs`, `core/lease/*.rs`                            | `core.rs`              | `native-core.ts`        | `core`          |
| G2c  | `non-executing`, `disabled-hooks`, `hook-command-words`, `config-facts`, `config-learning`, `config-sources`, `credential-helpers`, `transport-config`, `temporary-index`, `reviewer-hooks`, `reviewer-hooks-identity`, `types`, `decode`                                           | `core/{policy,config,credentials,transport,temp_index,reviewer,error,decode}.rs` | `core.rs`              | `native-core.ts`        | `core`          |
| G3a  | `parse`, `parse-status`, `parse-repository`, `parse-numstat`, `changed-files`, `checkout-facts`, `linked-worktrees`, `worktree-footprint`, `missing-worktrees`, info and remotes of `repository`                                                                                    | `reads/{status,info,changes,worktree_facts}.rs`, `parse/*.rs`                    | `reads.rs`             | `native-reads.ts`       | `reads`         |
| G3b  | `diff` (commit and index sides), `parse-diff`, `parse-index`, `diff-binary`, `blob-classifier`, `line-window`                                                                                                                                                                       | `reads/{diff,blob_classifier}.rs`, `parse/{diff,index}.rs`                       | `reads.rs`             | `native-reads.ts`       | `reads`         |
| G3c  | `history`, `parse-history`, `revision-lines`, `conflict-markers`, the reads of `merge-conflicts`                                                                                                                                                                                    | `reads/{history,revision_lines,conflicts}.rs`                                    | `reads.rs`             | `native-reads.ts`       | `reads`         |
| G3d  | `publication-scan`, `publication-sensitive`, `publication-yaml`, `publication-remote`, `remote-default-branch`, `remote-url`, `transfer-source`, `transfer-refs`, `transfer-ignored`, `transfer-branch-name`                                                                        | `reads/{publication,remote,transfer_reads}.rs`                                   | `reads.rs`             | `native-reads.ts`       | `reads`         |
| G4a  | `actions` (commit, stage, unstage, push, branch writes), `source-control-ops`, `writing-context`, `leased-push`, `ref-conflict`, `branch-cleanup`, `ace-private`, `integration`                                                                                                     | `writes/{commit,stage,push,branches,integration}.rs`                             | `writes.rs`            | `native-writes.ts`      | `writes`        |
| G4b  | `worktrees`, `worktree-cleanup`, `worktree-backup`                                                                                                                                                                                                                                  | `writes/worktrees.rs`                                                            | `writes.rs`            | `native-writes.ts`      | `writes`        |
| G4c  | `projects` (clone, init), `publication`, `publication-assignment-keys`, `publication-credentials`, `held-clone`, `object-transfer`, `transfer-bundle`, `transfer-bundle-file`, `transfer-clone`, `transfer-apply`, `transfer-checkout`, `transfer-origin-fetch`, `transfer-service` | `writes/{projects,publication}.rs`, `writes/transfers/*.rs`                      | `writes.rs`            | `native-writes.ts`      | `writes`        |
| G4d  | the writes of `merge-conflicts`, `stack-sync`, and the fetches of `remote-branches`                                                                                                                                                                                                 | `writes/{merge,stack,fetch}.rs`                                                  | `writes.rs`            | `native-writes.ts`      | `writes`        |
| G5   | `snapshot-index`, `checkpoints`, `checkpoint-bytes`, `checkpoint-metadata`, `checkpoint-numbers`, `nested`, `restore`, `restore-nested`, `transfer-capture`, the live sides of `diff`                                                                                               | `checkpoints/{snapshot,nested,numbers,metadata,bytes,restore}.rs`                | `checkpoints.rs`       | `native-checkpoints.ts` | `checkpoints`   |
| G6   | S9–S10 of the snapshot only (ADR 0224 §5, N9–N15)                                                                                                                                                                                                                                   | `checkpoints/hash.rs`                                                            | none                   | none                    | `snapshot-hash` |
| G7   | the source of `parseStatus`'s input, for display reads only                                                                                                                                                                                                                         | `reads/status_gix.rs`                                                            | none                   | none                    | `status-gix`    |

## G0: foundations (one builder, first)

- `ace-git` (`thiserror`, `ace-json`, `ace-supervisor`, the workspace `tokio`; `gix` only in the
  G1 and G7 modules), every module above as a stub, the binding modules with panics caught and
  thrown as `git_failed`.
- `ACE_GIT` in `native-switches.ts`: a comma list of `refs`, `core`, `reads`, `writes`,
  `checkpoints`, `snapshot-hash`, `status-gix`; unknown words, or a part without its
  prerequisites (`reads` without `core`; anything but `refs` without `ACE_SUPERVISOR=native`),
  refuse to start.
- **The port bridge** (`bridge.rs`, `native-core.ts`): each `GitProcessRuntime` member the caller
  injected is passed to the core as a callback; an injected `spawn` is wrapped so its
  `ChildProcess` streams stdin, stdout and stderr chunks and the exit (with the pid) to the core
  through one ordered queue, as ADR 0223 §7's rule 3 orders a session's events.
- **Logs**: `ACE_NATIVE_CROSS=ACE_GIT` (per-call alternation, both start orders in
  `scripts/native-cross.ts`), `ACE_GIT_DIGEST_LOG` with `scripts/native-git-digest.ts`,
  `ACE_GIT_VERIFY=strict|shadow`, and the per-operation record (selected, completed, fallback
  reason, the producer of each checkpoint and the consumer of each use of it). The digest log
  writes two records per write or failed write: the state digest and the completion record, as
  ADR 0224 §7 defines them; the scripts check postconditions, the producer → consumer edges each
  file exercises, native completions per test and operation, and strict verdicts with how each
  call's rows were produced.
  If G0 has already landed when this is read, these record kinds are a follow-up on the same
  files (`scripts/native-cross.ts`, `scripts/native-git-digest.ts`, `native-core.ts`).
- `deny.toml` bans `uluru`; `check:daemon-native` runs `cargo deny check`.
- Proof: `check:daemon-native`; every (a) file still passes with every part named (all stubs
  defer to TypeScript).

## G1: ref, branch and worktree-list reads on `gix`

Inside today's TypeScript service (no core needed): the shell replaces the processes of
`Repository.commit` (`rev-parse --verify --end-of-options <ref>^{commit}`, then
`symbolic-ref --quiet HEAD` for `unborn_head`), `branchHead`'s ref lookup (its
`check-ref-format` stays Git), `listBranches`, `branchRefs` and `Repository.worktrees`.

- **Each caller keeps its decoder** (ADR 0224 §6). Worktrees: emit the records of
  `worktree list --porcelain -z` and decode them with `parseWorktrees`
  (`parse-repository.ts:6`), which requires absolute paths (`:36`). Branch listings: emit
  `for-each-ref`'s lines for the format of `remote-branches.ts:79`–`:85`, in its sort order
  (`-committerdate`, then `refname`), with `--count`; the shell applies the 8 MiB cap to those
  bytes (`:87`–`:89`) and `parseRef` (`:97`) skips what `BranchRef.safeParse` skips (`:103`,
  `:115`). `upstream:short` and `upstream:track,nobracket` exactly as Git prints them
  (`ahead N`, `behind N`, `ahead N, behind M`, `gone`, empty).
- **Fallbacks**: reftable (`reftable`); a prunable worktree, or a locked reason that isn't the
  `locked` file's text (`worktree_reason`); `directoryFd` calls (rule 5); a non-default
  `gitBinary` or an injected `spawn` (`injected`).
- Proof: `repository.process`, `remote-branches.process`, `remote-default-branch.process`,
  `worktrees.process`, `worktree-cleanup.process`, `worktree-recovery.process`,
  `worktree-progress.process`, `branch-cleanup.process`, `client-actions.process`,
  `source-control-ops.process`, `malformed.process` (stays CLI: injected binary),
  `failure-categories.process`, `cache-lifetime.process`, `cache-races.process`,
  `push-rejections.process`, `leased-push.process`; then the daemon's `workspace-runtime` and
  `pr-head` tests, one at a time.
- Measure: `branchRefs`, `branches`, `resolveCommit HEAD`, `branchHead`, `listWorktrees`.

## G2: the core (three items, after ADR 0223 E2)

- **G2a, processes.** `GitCli.executeRaw` (`cli.ts:706`) on the supervisor: the environment
  (`:714`–`:734`), `--no-pager`, detached groups or jobs, the capture limit and its two bounded
  modes, deadlines (`git_timeout` with `args`), cancellation before and after dispatch,
  `git_closed`, `runningChildren`, the Windows strategy chosen by the `platform` port (so the
  taskkill tests keep running on macOS), and spawning in a `directoryFd` (rule 5 until the
  supervisor can). Stderr tails redact before they clip (ADR 0224 §8a rule 3): the fix to
  `failure-text.ts:28` lands in TypeScript first with a test, then you port the fixed version.
  (b): `diagnostics`. Proof: `process-runtime.process`, `timeout-cleanup.process`,
  `escaped-descendants.process`, `read-cancellation.process`, `reliability.process`,
  `cleanup-receipts.process`, `lifecycle.process`, `system-transport.process`.
- **G2b, ordering and leases.** `serial` per canonical root across instances, `ReadGate(2)`,
  root discovery and its cache, the lease journal (same files and records, so a lease one backend
  wrote is read by the other), admission, quarantine, healing, stale locks, the Git process scan
  through the `gitProcesses` port. (b): `read-gate`, `lock-sweep`, `lock-timestamps.process`,
  `restart-locks.process`. Proof: `stale-leases.process`, `self-healing.process`,
  `held-directory.process`. `cache-races`, `cache-lifetime` and `numbering` exercise `serial` and
  `ReadGate`, which only G4 wires into the write path, so they join this item's proof then.
- **G2c, policy and configuration.** The execution policy and its overrides
  (`non-executing.ts:35`–`:52`, `:113`–`:130`, including `GIT_ATTR_NOSYSTEM`,
  `GIT_NO_LAZY_FETCH`, `GIT_ALLOW_PROTOCOL`), hook switches, config facts and their stamps,
  credential helper sources (system and global only), transport protocols, temporary-index
  settings, reviewer hooks, the error type and `decode`'s schemas. (b): `config-sources`,
  `checkout-facts`. Proof: `non-executing.process`, `non-executing-hooks.process`,
  `non-executing-partial-clone.process`, `non-executing-race.process`,
  `non-executing-submodule.process`, `person-hooks.process`, `reviewer-hooks.process`,
  `disabled-hooks.process`, `action-permission.process`, `config-facts.process`,
  `credential-helpers.process`, `transport-config.process`.
- G2 ships when all its proof passes both ways and the lease and timeout files pass in the Windows
  VM.

## G3: reads on the core

Each read keeps its exact Git command and its strict parse, ported.

- **G3a**: status, info, remotes, `changedFiles`, `sourceControlState` and `sourceControlStatus`,
  `changeSummary`, `checkoutSummary`, worktree facts. (b): `malformed-output`'s `parseStatus`,
  `parseWorktrees` and `parseRemotes` cases. Proof: `repository.process`,
  `changed-files-regressions.process`, `checkout-paths.process`, `malformed.process`,
  `failure-categories.process`.
- **G3b**: commit and index diffs, patches with their byte bound and UTF-8 cut, the metadata
  guard, the binary classifier over `cat-file --batch`. (b): `malformed-output`'s `parseDiff`,
  `parseIndex`, `parseTree` and `BlobClassifier` cases. Proof: `diff-resources.process`,
  `review-regressions.process`, `diff.process`'s commit-side cases (its live cases wait for G5).
- **G3c**: `fileLog`, `diffCommit`, `readRevisionLines`, `conflicts`. (b): `conflict-markers`;
  `history.process`'s two `GitCli`/`ReadGate` cases move to G2's Rust tests. Proof:
  `history.process`, `merge-conflicts.process` (read cases).
- **G3d**: publication scans, the remote default branch, remote URL normalisation, transfer
  reads. (b): `publication-sensitive`. Proof: `transfer-names`, `remote-url`,
  `remote-default-branch.process`, `transfer-bundle.process` (read cases).
- Then the 39 daemon test files that use a real `GitService`, one at a time.

## G4: writes that make no checkpoint

Commits, staging, merges, stack replays, branches, worktrees, fetch, push, clone, init, transfers
and publications run today's Git commands from the core. Each runs the person's hooks and signing
in their roots exactly where TypeScript does (`commitMerge`, `index.ts:395`), and none in
protected roots.

- **Digests**: every file of your proof list passes `scripts/native-git-digest.ts` before your
  part may be named in a default: identical state digests (refs with commit parents, the index
  with stages and flags, operation state files such as `MERGE_HEAD`, raw checkout bytes,
  worktree registrations, local config, the fixture remote's refs), identical completion records,
  and each write's postconditions (ADR 0224 §7): a commit moves only its branch and leaves no
  operation state; stage and unstage change only the named index rows; merge start, abort,
  `takeSide`, `writeResolution` and `commitMerge` leave exactly their documented stages and
  files; a fetch changes only remote-tracking refs; a failed write leaves the digest unchanged.
- **G4a** proof: `client-actions.process`, `source-control-ops.process`, `integration.process`,
  `leased-push.process`, `push-rejections.process`, `branch-cleanup.process`,
  `person-hooks.process`, `reviewer-hooks.process`, `action-permission.process`.
- **G4b** proof: `worktrees.process`, `worktree-cleanup.process`, `worktree-recovery.process`,
  `worktree-progress.process`, `worktree-hooks.process`.
- **G4c** proof: `transfer-bundle.process`, `transfer-landing.process`,
  `transfer-origin-restore.process`, `project-transfer-clone.process`,
  `non-executing-transfers.process`, `non-executing-partial-clone.process`, then the daemon's
  `transfers/` and `projects` tests one at a time.
- **G4d** proof: `merge-conflicts.process`, `remote-branches.process`, the daemon's
  `forge-stack-sync` tests.

## G5: checkpoints, live diffs and restore, step for step

Port S1–S13 of ADR 0224 §5 exactly: the same commands in the same order with the same
environment and temporary-index settings (`temporary-index.ts`), the same nested discovery
(`nested.ts:48`–`:110`; one directory walk instead of a `stat` per ancestor is allowed only if it
yields the same candidates, which the nested files prove), flattening, the gitlink refusal,
sequence allocation with compare-and-swap, the bounded counter cache, and restore's safety
capture, collision checks and child locks (`restore.ts:17`–`:70`).

- (b): `malformed-output`'s `parseCommits` cases. Proof: `snapshot-index.process`,
  `checkpoints.process`, `checkpoint-bytes.process`, `checkpoint-deadline.process`,
  `numbering.process`, `workspace-revision.process`, `nested.process`, `nested-linked.process`,
  `untracked-links.process`, `diff.process`, `diff-resources.process`,
  `review-regressions.process`, `audit-restore.process`, `audit-deletion.process`,
  `audit-ownership.process`, `audit-cli.process`, `credential-restoration.process`, the
  non-executing files, `transfer-capture.process`, the daemon's `run-checkpoints.process`.
- **Restore (ADR 0224 §5a, hard rules).** The safety capture always runs the CLI snapshot
  (S1–S13 with `git add`), whatever `ACE_GIT` says. Port today's restore step for step. The guard
  is new behaviour and lands in TypeScript first, with its own tests, in its own change; you port
  it after:
  - touch set per repository: every path of its owned safety tree and owned target tree, with
    ancestors (not only the differences: the reset can rewrite an unchanged entry);
  - witness: stat (type, mode, size, mtime and ctime in nanoseconds, device, inode) of the
    target's paths and the listed files before S1, again after S13, plus raw-byte hashes and
    symlink targets of the safety tree's paths; a moved tuple or a safety path missing from the
    first stat is drift during the capture;
  - plan, check, apply over the whole hierarchy: owned trees, subtrees and child object copies
    first; then the check of every repository's touch set (stat; raw re-hash where stat moved),
    the raw index bytes and HEAD; writes only after every check passes, parent first, each child
    re-checked just before its write;
  - on drift before any write: new capture from S1, twice at most, then fail without writing; a
    child drifting after the parent was written stops there with `safetyCheckpointId` and the
    repositories written.
- Gate: identical state digests and completion records for every file above (checkpoint trees and
  refs; after a restore, the checkout's raw bytes, ignored files included, with HEAD and the index
  unchanged, never a fresh snapshot's tree), the postconditions, and ADR 0224 §7's cross list both
  ways with both producer/consumer pairs. Expected fallbacks: none (G5 has no `gix`).

## G6: `snapshot-hash` (blocked until G5 ships)

Only S9–S10 change, and only as ADR 0224 §5 N9–N15 says: Git lists `C`, Git reports
attributes, Rust hashes `C \ L` read-only through `cap-std` from the identity-checked root, Git
checks ids and writes missing objects (and the ids it prints must equal Rust's), Git takes the
changed rows and adds `L`, the inputs are revalidated, and S11–S13 run as before.

- **Revalidation (N15)** re-reads all of: HEAD's target and tree, the person's index file
  identity (through Git; a published index is read while `index.lock` exists, as today), the
  nested scan, the candidate set `C`, every `.gitignore` in `C`'s directories and their ancestors,
  `info/exclude`, `core.excludesFile`, every `.gitattributes` there, `info/attributes`, the config
  stamp, the global and system attributes files (`core.attributesFile`; the system file unless
  `GIT_ATTR_NOSYSTEM`), the stat of every hashed path, and the stat of every `L` path Git added
  (taken just before N14 and again), after N14 and before S11. Any drift discards the
  attempt and restarts **from S1** on the CLI path, once (`inputs_changed`); never from S4.

- Preconditions and `L` exactly as N10–N11; reasons `config`, `attributes` (per path, counted),
  `hash_mismatch`, `inputs_changed`, `injected`.
- A case for each reason in `checkpoints/hash.rs`'s tests (new behaviour: nothing triggers them
  today); the commit says so.
- Gate: every file of G5's proof under `ACE_GIT_VERIFY=strict` with zero differences in both
  cross orders, then `ACE_GIT_VERIFY=shadow` on read-only clones of this repository and the main
  checkout with zero differences. Expected fallbacks: `attributes` in `snapshot-index.process`'s
  filter and line-ending cases (`:164`, `:197`) and in `non-executing.process`; `config` where a
  file sets `core.fileMode` or `core.symlinks` false.
- **Never restore's safety capture** (`restore.ts:17`, ADR 0224 §5a rule 1): `snapshot-hash`
  serves checkpoints, live diffs and `workspaceRevision` only.
- **The bench (ADR 0224 §10a)** before any saving is claimed: extend `benchmark-ops.ts` to time
  `createCheckpoint`, `diff` HEAD → working tree, `workspaceRevision` and `restoreCheckpoint` end
  to end with `ACE_GIT_VERIFY` off; report wall p50/p90, daemon CPU (Rust threads included), Git
  children's CPU, peak RSS of both, Git processes, loose objects written, each Git step's time,
  fallbacks by reason and time queued (`serial`, `ReadGate`, the native semaphore); on this
  repository's clone, the main checkout's clone, a 100,000-file synthetic repository, a
  `text=auto`/CRLF variant of each, and a concurrent run; three runs each way with the load
  average. Claim a saving only if p50 wall and total CPU are lower in every run on every
  repository.

## G7: `status-gix` (after G1 ships, and the owner's answer)

Only for the display reads: `changedFiles`, `sourceControlState`, `sourceControlStatus`,
`changeSummary`, `checkoutSummary` and `repositoryInfo` (`changed-files.ts:181`, `:241`, `:256`,
`:288`, `:302`; `repository.ts:136`). Every status read that precedes or guards a write stays on
Git: `actions.ts:63`, `:259`; `merge-conflicts.ts:52`, `:86`, `:114`, `:193`;
`source-control-ops.ts:102`; `stack-sync.ts:108`; `temporary-index.ts:82`;
`transfer-checkout.ts:21`; `index.ts:441`; and the public `GitService.status` (`index.ts:462`).

- The same entries as porcelain v2 with `--renames` (Git's rename pairing and limits),
  `--untracked-files=all`, conflict codes, branch, upstream and ahead/behind, under
  `GIT_OPTIONAL_LOCKS=0` semantics (no index write).
- Fallbacks: `core.fsmonitor` in a person's root, any submodule, `injected`.
- Gate: G3a's proof and the 39 daemon files under `ACE_GIT_VERIFY=strict` (the decoded status
  compared with the CLI's), with native completions in every test that selected native, and
  ADR 0224 §10a's bench for `checkoutSummary` and `sourceControlState`: lower wall, no more CPU.
