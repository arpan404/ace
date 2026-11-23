# Moving Git snapshots and reads into the addon

For the builders of [ADR 0224](../adr/0224-git-reads-move-in-process-git-writes-and-forge-stay.md),
one work item each. Read the ADR and [behaviour.md](behaviour.md) first: the contract there is
what you keep, and behaviour.md §12 lists every test file by class. Where this guide is silent,
follow [the engine's porting guide](../engine/porting-guide.md); its rules 6, 7, 9, 11, 12 and 13
apply here word for word.

Branch from `ace/rust-git-forge` once G0 has landed on it, one branch per work item
(`ace/rust-git-<item>`).

## Rules for every work item

1. **Same TypeScript interface.** `GitService`, `GitTransfer` and every export of `@ace/git` keep
   their signatures, results, error codes and timing. You replace one internal step (ADR 0224 §1),
   never a `GitService` method, and never the orchestration around it: `serial`, `ReadGate`,
   leases, quarantine, deadlines, cancellation and error mapping stay TypeScript.
2. **One switch, one line.** G0 puts an `if` at the top of each replaced step that calls your
   shell function when `ACE_GIT` names your part; until you build it, the shell returns
   `undefined` and the CLI step runs. You edit only your shell file and your Rust files. With the
   switch on and the addon missing, fail at startup; never fall back for that.
3. **Fall back, never guess** (ADR 0224 §3). Your native step reads the facts it depends on first
   and returns `{ fallback: "<reason>" }` for anything it doesn't reproduce exactly; the shell then
   returns `undefined` and the CLI step runs in the same `serial` turn and lease. A fallback is
   counted (`resourceUsage().nativeFallbacks[reason]`), never an error, never a partial result.
   When in doubt about a configuration, add it to the fallback list rather than modelling it.
4. **No new tests through TypeScript.** The class (a) files of your item are the proof; you don't
   edit them. Run each alone, switch on and off. Check the path exists first: an empty path runs
   the whole suite.

   ```sh
   f=packages/git/src/checkpoints.process.test.ts
   test -f "$f" && ACE_GIT=snapshot bun --bun x vitest run "$f" --maxWorkers=4
   test -f "$f" && bun --bun x vitest run "$f" --maxWorkers=4
   ```

   Never run the full suite, `bun run test`, `bun run check`, or `test:process`, `test:slow`,
   `test:changed`; the machine is shared. One file at a time.

5. **Rust tests only for what nothing covers.** All (b) files of `@ace/git` cover modules that
   stay TypeScript; no case moves. Your fallback detection (rule 3) gets `#[cfg(test)]` cases in
   temp repositories, one per reason, because today's tests don't set those configurations up;
   the commit says so. No parity harness, no vectors generated from the CLI, no "run both and
   compare".
6. **Paths and refs cross as bytes.** Return path and ref names as `Buffer` and let the shell run
   the existing `decode` with `pathSchema` or `refSchema` (`decode.ts:7`, `:24`); return ids as
   lowercase hex. No JSON crosses; results are `#[napi(object)]` values. Never build a JavaScript
   shape in Rust that TypeScript then re-parses.
7. **Off the JS thread, bounded.** Each call is one task on the addon runtime's blocking pool;
   at most two native Git tasks run at once (a semaphore in `ace-git`), each with at most four
   threads inside (`gix` `thread_limit`, the hashing fan-out).
8. **Stop late, never early.** The shell passes a cancel handle; abort and the call's deadline set
   its `AtomicBool`. Pass it to `gix` where it takes one (`should_interrupt`) and check it between
   files in your own loops. The promise settles only after the task returned; the shell then fails
   `git_cancelled` or `git_timeout` exactly as the CLI path does (`cli.ts:745`, `:920`–`:922`).
9. **Nothing executes.** No hooks, no filter drivers (fallback), no fsmonitor, no process of any
   kind from `ace-git`. In protected roots apply the overrides of `non-executing.ts:35`–`:52` as
   configuration overrides when opening the repository (`core.attributesFile=/dev/null` above
   all). Match Git's `safe.directory` refusal and map it to the CLI path's code.
10. **Same numbers.** Limits and budgets are contract: `sourceControlState`'s 500-entry sections,
    `branches`' truncation, the 64 MiB metadata guard where a list could exceed it.
11. **`gix` features**: `default-features = false`, `status`, `parallel`, `revision`, `sha1`,
    `sha256`, `attributes`, `excludes`, `dirwalk`. Never `pack-cache-lru-static` (it pulls an
    MPL-2.0 crate); run `cargo deny check` in `native/daemon` after any feature change.
12. **Never touch the person's repositories.** Tests use the temp repositories of `test-repo.ts`;
    benches clone with `git clone --local` into a temp directory (`benchmark-ops.ts`). Never run a
    native step on a checkout you didn't create.
13. **Measure before you finish**, switch off and on, and report both:

    ```sh
    node packages/git/benchmark-ops.ts . --calls=10 --only=createCheckpoint,status
    ACE_GIT=snapshot node packages/git/benchmark-ops.ts . --calls=10 --only=createCheckpoint,status
    ```

14. **Cross-mode gate** (ADR 0224 §6): run your item's list with `ACE_NATIVE_CROSS=ACE_GIT`,
    which alternates the backend per call, through `scripts/native-cross.ts`; it fails unless both
    backends served calls in the file. Same rules as rule 4.

    ```sh
    f=packages/git/src/checkpoints.process.test.ts
    test -f "$f" && bun scripts/native-cross.ts ACE_GIT "$f"
    ```

## Files per work item

G0 creates every file below as a stub and declares every module, so no two builders edit the same
file. Rust paths in `native/daemon/crates/`.

| Item | Rust (yours)                                                   | Binding (yours)                       | TypeScript shell (yours)                     | Switch             |
| ---- | -------------------------------------------------------------- | ------------------------------------- | -------------------------------------------- | ------------------ |
| G0   | `ace-git/src/{lib,error,open,cancel,limits}.rs`, `Cargo.toml`  | `ace-daemon-node/src/git/mod.rs`      | `packages/git/src/native.ts`, the `if` lines | `ACE_GIT` parsing  |
| G1a  | `ace-git/src/snapshot/{facts,nested}.rs`                       | `ace-daemon-node/src/git/scan.rs`     | `packages/git/src/native-scan.ts`            | `ACE_GIT=snapshot` |
| G1b  | `ace-git/src/snapshot/{mod,files,hash,tree}.rs`                | `ace-daemon-node/src/git/snapshot.rs` | `packages/git/src/native-snapshot.ts`        | `ACE_GIT=snapshot` |
| G2   | `ace-git/src/{refs,worktrees}.rs`                              | `ace-daemon-node/src/git/refs.rs`     | `packages/git/src/native-refs.ts`            | `ACE_GIT=refs`     |
| G3   | `ace-git/src/status/{mod,tree_index,index_worktree,branch}.rs` | `ace-daemon-node/src/git/status.rs`   | `packages/git/src/native-status.ts`          | `ACE_GIT=status`   |

## G0: foundations (one builder, first)

- `ace-git` with `gix` as rule 11 says, `thiserror`, the workspace `tokio`; `open.rs` opens a
  repository with the trust and override rules of rule 9 and takes a `protected: bool`;
  `cancel.rs` the cancel handle (an `Arc<AtomicBool>` behind a napi class); `limits.rs` the
  two-task semaphore and the thread limit; `error.rs` the enum and its codes (ADR 0224 §2).
- `ace-daemon-node/src/git/mod.rs`: `mod` lines for every binding file above, panics caught and
  thrown as `git_failed`.
- `ACE_GIT` in `packages/provider-kit/src/native-switches.ts` beside ADR 0223's switches: a comma
  list of `snapshot`, `refs`, `status`; unknown words refuse to start. `ACE_NATIVE_CROSS=ACE_GIT`
  alternates per call and appends one line per call (`backend`, `part`) to `ACE_NATIVE_CROSS_LOG`;
  `scripts/native-cross.ts` learns the per-call mode and asserts both backends appear.
- `packages/git/src/native.ts`: loads the addon through provider-kit's loader, exposes the switch
  decision per part, the cancel handle bound to a signal and a deadline, and `nativeFallbacks`
  counting (added to `resourceUsage()`, `index.ts:249`).
- The `if` lines, one per replaced step, each calling a shell stub that returns `undefined`:
  `withSnapshotIndex`'s caller in `snapshot` (`checkpoints.ts:28`), `captureChanges`'s tree in
  `transfer-capture.ts:58`, `Repository.state` (`repository.ts:113`), `Repository.commit`
  (`:156`), `Repository.worktrees` (`:90`), `branchRefs` (`remote-branches.ts:34`), `branchHead`
  (`:150`), `listBranches` (`actions.ts:274`). Restore discovery (`restore-nested.ts:23`) keeps the
  CLI path.
- Proof: `check:daemon-native` passes; `cargo deny check` passes; with `ACE_GIT=snapshot,refs,status`
  every (a) file of behaviour.md §12 still passes (every stub falls back).

## G1a: the facts and the nested-checkout scan

Replaces the CLI-and-`stat` discovery of `nested.ts:48`–`:110` (`nestedCheckouts`,
`candidatePaths`, `repositoryPaths`) and computes the fallback facts for G1b in the same pass.

- **Facts** (`facts.rs`): sparse checkout (then the shell throws today's `unsupported_repository`,
  `snapshot-index.ts:19`–`:26`), filter drivers selected by attributes for any path in an
  unprotected root, `core.safecrlf=true` with an eol conversion in effect (outside Windows), split
  index, `core.sharedRepository`, `extensions.refStorage`, index versions or extensions `gix`
  doesn't read. Each is a fallback reason, named as the ADR names it.
- **Nested scan** (`nested.rs`): the same candidates as `candidatePaths` (tracked gitlinks, and
  untracked directories that hold a `.git` entry) and the same linked-worktree exclusion, read
  with one directory walk instead of a `stat` per ancestor. Any nested checkout or gitlink found is
  a fallback for G1b (their flattening and object transfer stay on the CLI path); the list itself
  is returned so the CLI path doesn't scan again.
- Proof: `nested.process`, `nested-linked.process`, `untracked-links.process`,
  `snapshot-index.process`, `non-executing-submodule.process`, `restore` audits
  (`audit-restore.process`, `audit-ownership.process`), and the lease row of behaviour.md §12.
- Measure: the daemon CPU column of `createCheckpoint` (today 436 ms on this repository).

## G1b: snapshot tree building

Replaces the temporary-index work of `withSnapshotIndex` and `snapshot` (`snapshot-index.ts:13`–`:50`,
`checkpoints.ts:22`–`:100`) for repositories G1a didn't hand back: `rev-parse HEAD^{tree}`, both
`ls-files --stage`, `read-tree`, `update-index --index-info`, `add`, `write-tree`. The checkpoint
commit and its refs (`commit-tree`, `update-ref`) stay CLI.

- **File set** (`files.rs`): HEAD's tree ∪ the person's index entries (stage 0 and unresolved
  stages as the temporary index records them today) ∪ untracked nonignored files, with
  `assume-unchanged` and `skip-worktree` flags ignored, force-added ignored files kept, untracked
  ignored files excluded, `core.ignorecase` honoured. Paths compared and sorted as Git does.
- **Blob ids** (`hash.rs`): read every regular file and symlink; apply Git's built-in
  conversions through `gix-filter` with drivers disabled; compute ids on at most four threads;
  write each blob the object store doesn't already have, atomically. Modes from `lstat` with
  `core.fileMode` and `core.symlinks` as Git applies them. Ignore stat data entirely (ADR 0224,
  question 1 decides any cache later).
- **Tree** (`tree.rs`): canonical tree objects, written bottom-up; returns the root tree id.
- **Lease**: the shell calls you inside the same `serial` turn and the same write lease as the CLI
  `git add` (`cli.call(..., { write: true })` today); it releases the lease when your promise
  settles (rule 8).
- Proof: `snapshot-index.process` (18), `checkpoints.process` (11), `checkpoint-bytes.process`,
  `checkpoint-deadline.process`, `numbering.process`, `workspace-revision.process`,
  `diff.process`, `diff-resources.process`, `review-regressions.process`,
  `transfer-capture.process`, `untracked-links.process`, the non-executing row
  (`non-executing*.process`, `person-hooks.process`, `config-facts.process`), the lease row
  (`stale-leases.process`, `self-healing.process`, `held-directory.process`,
  `timeout-cleanup.process`, `read-cancellation.process`, `reliability.process`), then the
  daemon's `apps/daemon/src/run-checkpoints.process.test.ts` and transfer tests one at a time; the
  cross-mode list (ADR 0224 §6).
- Ships when (ADR 0224 §8): `createCheckpoint` on this repository at most a third of the CLI's
  wall, no more total CPU, zero (a) diffs.

## G2: ref, branch and worktree-list reads

Replaces the processes behind `Repository.commit` (`rev-parse --verify <ref>^{commit}`),
`branchHead` (`check-ref-format`, `rev-parse`), `listBranches` (`for-each-ref refs/heads` with its
truncation), `branchRefs` (`remote`, `symbolic-ref`, `for-each-ref`), and `Repository.worktrees`
(`worktree list --porcelain -z`).

- Results as the parsers produce them today (`parseWorktrees`, `parse-repository.ts:6`, and the
  `remote-branches.ts` records), names as `Buffer` (rule 6). Ref name validity is still checked by
  the shell's `refSchema` and by `gix-validate` the way `check-ref-format` checks it; a name either
  rejects is refused with today's code.
- Worktree entries: path, HEAD, branch or detached, bare, locked reason, prunable reason. When
  `gix` can't produce a locked or prunable reason exactly as Git words it, fall back for that
  repository (reason `worktree_reason`).
- Reftable repositories fall back.
- Proof: `repository.process`, `remote-branches.process`, `remote-default-branch.process`,
  `worktrees.process`, `worktree-cleanup.process`, `worktree-recovery.process`,
  `worktree-progress.process`, `branch-cleanup.process`, `client-actions.process`,
  `source-control-ops.process`, `malformed.process`, `failure-categories.process`,
  `cache-lifetime.process`, `cache-races.process`, `push-rejections.process`,
  `leased-push.process`, then the daemon's `workspace-runtime` and `pr-head` tests one at a time.
- Measure: `branchRefs`, `branches`, `resolveCommit`, `branchHead`, `listWorktrees` in
  `benchmark-ops.ts`.

## G3: status (only after G1 and G2 ship, and the owner's answer to question 4)

Replaces `git status --porcelain=v2 -z --branch --ahead-behind --no-show-stash
--untracked-files=all --renames --ignore-submodules=none` (`repository.ts:113`–`:131`) and its
parse, returning the shape `parseStatus` returns (`parse-status.ts:53`).

- `tree_index.rs`: staged entries with Git's default rename pairing for status (similarity,
  rename limit from `status.renameLimit`/`diff.renameLimit`), letters as porcelain v2 reports
  them; `index_worktree.rs`: unstaged entries, with the same racy-entry handling Git applies under
  `GIT_OPTIONAL_LOCKS=0` (no index write); untracked, all files; conflicted entries with their
  two-letter codes; `branch.rs`: branch, detached HEAD, unborn (`head: null`), upstream,
  ahead/behind.
- Fallbacks: `core.fsmonitor` in an unprotected root, any submodule (their state letters), and
  G1a's facts.
- Proof: everything of G2, plus `changed-files-regressions.process`, `checkout-paths.process`,
  `merge-conflicts.process`, `integration.process`, the non-executing row, and the 39 daemon test
  files that use a real `GitService`, one at a time.
- Ships when: lower wall and no more total CPU than the CLI on this repository and on a
  100,000-file synthetic one (`benchmark.ts 100000` builds it).

## G4: Git processes on the Rust supervisor

No Git work item: once ADR 0223's E2 is default-on, `processRuntime.spawn` (`types.ts:28`,
`process-runtime.ts:10`) is backed by the supervisor's spawn with the same group and job rules,
and `GitService` doesn't change. Proof: the process-boundary and lease rows of behaviour.md §12
with `ACE_SUPERVISOR=native`.
