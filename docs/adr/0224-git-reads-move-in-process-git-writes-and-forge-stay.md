# 0224: Git snapshots and reads move in process; Git writes and the forge stay

Date: 2026-11-23. Status: proposed (draft for the owner). Decided by: pending the owner.

## Context

The owner wants `packages/git` (status, diffs, worktrees, branches; today a `git` process per
step) and `packages/forge` (GitHub and other hosts through the person's CLIs) in Rust next, after
the store ([ADR 0222](0222-the-event-store-moves-to-rust-behind-the-same-store.md)) and the
engine and adapters ([ADR 0223](0223-the-engine-and-adapters-move-to-rust-behind-the-same-interfaces.md)).
Their contracts are [docs/git/behaviour.md](../git/behaviour.md) and
[docs/forge/behaviour.md](../forge/behaviour.md). ADR 0222's lessons apply: Rust that must
reproduce JavaScript-shaped output diverges; a Rust path whose result JavaScript parses again can
be slower than TypeScript; the existing tests are the proof; measure first.

### What there is to move

| Package      | Source lines | Modules | Test files (tests)   | Callers                                                   |
| ------------ | ------------ | ------- | -------------------- | --------------------------------------------------------- |
| `@ace/git`   | 14,873       | 109     | 80 (380), 70 process | 57 daemon modules, `packages/review`, `orchestrator`      |
| `@ace/forge` | 21,544       | 145     | 83 (588), 44 process | 57 daemon modules; 31 browser modules use 13 pure entries |

### Measurements (2026-11-23)

Taken on an M-series Mac (16 cores) shared with other work, load average 17 to 100, so absolute
times are noisy; each figure is a median and was repeated at least twice. No real host was
called, no credential was read, and the person's Git configuration was isolated (`HOME`,
`XDG_CONFIG_HOME`, `GIT_CONFIG_NOSYSTEM`). Git: a `git clone --local` of this repository
(23,528 tracked files, 195.7 MB, 14,669 commits) with 12–20 files edited, 5 staged and 10
untracked, measured with the new `packages/git/benchmark-ops.ts` (results committed as
`packages/git/ops-benchmark.json`), the existing `apps/daemon/bench/git-spawns.ts`, a CPU profile
of six live diffs, and a throwaway `gix` 0.91 probe outside the repository. Forge: the new
`packages/forge/bench/transport.ts`, the existing `bench/status.ts`, and 20 runs of `gh --version`
with an empty config directory.

**Git, per call** (behaviour.md §11 has the full table):

| Call                                                     | Processes | Wall       | Daemon CPU | Git CPU  |
| -------------------------------------------------------- | --------- | ---------- | ---------- | -------- |
| `createCheckpoint` (before every send, after every turn) | 11        | 1,649 ms   | 436 ms     | 1,479 ms |
| `diff` HEAD → working tree                               | 13        | 1,635 ms   | 446 ms     | 1,498 ms |
| `workspaceRevision`                                      | 10        | 1,957 ms   | 440 ms     | 1,951 ms |
| `status`                                                 | 1         | 181–216 ms | 6 ms       | 293 ms   |
| `checkoutSummary` (a thread's details)                   | 2         | 253 ms     | 11 ms      | 389 ms   |
| `branchRefs`                                             | 5         | 17–22 ms   | 11 ms      | 17 ms    |
| `branches`, `listWorktrees`, `resolveCommit`             | 1         | 9–28 ms    | 3–5 ms     | 0–3 ms   |

- **Snapshots dominate.** Of a snapshot's 1.4 s inside Git, `git add` re-hashing every tracked
  file takes 1.15–1.27 s (by design: the temporary index has no stat data, so a checkpoint holds
  the bytes on disk, `snapshot-index.ts:9`–`:12`), at 36 MB peak RSS. The daemon's own 310–440 ms
  of CPU per snapshot is mostly the nested-checkout scan (`nested.ts:65`, `:96`): thousands of
  `stat` calls, half of which fail and throw, plus path decoding, the hash regex, `parseIndex`
  and Zod. The checkpoint before a send is awaited before delivery (`run-checkpoints.ts:166`), so
  on a repository this size every message waits about 1.6 s for it.
- **Hashing parallelises.** The same files: one `git hash-object` 0.85–2.15 s, eight in parallel
  0.29–0.32 s; Rust (`gix` blob ids, raw bytes) 487 ms on one thread, 230 ms on four.
- **Process starts are small.** A Git process costs 5–10 ms of CPU and 9–15 ms of wall (the macOS
  `xcrun` shim, avoided today, would double it). The daemon spawns 1.4 Git processes a minute idle
  for a project of six threads and 2.9 with a client viewing one; a thread's details cost one or
  two.
- **`gix` in process**, same clone: status with untracked files 48–74 ms (Git through
  `GitService`: 181–216 ms) at about the same total CPU, spread over threads; `rev-parse` 0.05 ms,
  local branches with upstreams 0.08 ms, all 460 refs 0.23 ms, worktree list under 0.01 ms. The
  probe's peak RSS was 50 MB (Git status alone: 14 MB).
- **`gix`'s licences** pass `native/daemon/deny.toml` with `default-features = false` and the
  features `status`, `parallel`, `revision`, `sha1`, `sha256` (143 crates). The
  `pack-cache-lru-static` feature pulls `uluru` (MPL-2.0) and must stay off.

**Forge, per request:** the CLI's own start is 35 ms wall, 31 ms CPU and 41 MB peak RSS (`gh`), and
each `gh api` run opens a new TCP and TLS connection; the daemon's side is 3.1–3.7 ms wall and
1.1–1.9 ms CPU for spawn, pipes and capture, `JSON.parse` 0.01–0.75 ms (1 to 1,000 records), and
decoding, Zod and revision reuse 0.04–0.9 ms. The network is the rest and the largest part.

### Which parts would gain from Rust

- **Gain: snapshots.** Building the tree in process, hashing in parallel and scanning for nested
  checkouts in Rust removes about 1.3 s of the 1.6 s on this repository, on the send path. Nothing
  else measured is close.
- **Small gain: ref and branch reads.** 10–20 ms and one to five processes per call, on reads that
  run when a person opens a picker or a thread. Cheap to do exactly (refs are refs).
- **Modest gain, real risk: status.** About 130–160 ms of wall per status at equal CPU, on reads
  that run one to three times a minute; status semantics (rename pairing, submodule states,
  conflict codes, ahead/behind) are where a second implementation can differ from Git.
- **No gain: everything else in `@ace/git`.** Commits (the person's hooks and signing), pushes,
  fetches and clones (the person's credential helpers and SSH), merges, stack replays, checkout and
  restore (smudge filters), patches (Git's diff output is the format), file history with renames,
  bundles: each is one to a few processes whose cost is Git's own work, and Git is the reference
  for its own behaviour. The orchestration around them (per-root ordering, leases, quarantine,
  timeouts, error mapping) costs 2–11 ms of daemon CPU a call.
- **No gain: `@ace/forge`.** The daemon spends 1–3 ms a request; the CLI start, the connection
  and the host are the cost, and Rust removes none of them while a CLI makes the request.

### Facts the design must respect

1. **ace never holds host or Git credentials** (ADR 0002). Remote Git operations and every host
   request run the person's CLI; that is why forge requests are processes.
2. **Nothing of a protected root executes** (behaviour.md §4): no hooks, filter drivers,
   fsmonitor or global attributes file. In the person's own roots their clean filters and
   attributes do apply to snapshots.
3. **Git's output is validated strictly** (behaviour.md §10), not leniently: a deviation is
   `malformed_output`. A native path has no text to parse, but must produce the same paths,
   modes and ids or refuse with the same codes.
4. **Writers are fenced by leases** that outlive a killed process (ADR 0068). A native writer has
   no process to kill; its lease must still end only when its work has.
5. **The browser uses forge's pure entries** (13 subpaths, 31 modules in `apps/web`, `ui-core`,
   `fake-daemon`), so they stay JavaScript whatever the daemon does.
6. **The machine is shared**: native work is bounded in threads, as the daemon's other work is.

## Decision

### 1. The boundary stays `GitService`; Rust replaces three reads below it

`GitService`, `GitTransfer` and every export keep their signatures, results and error codes. The
TypeScript keeps the orchestration: root discovery cache, `serial` per root, `ReadGate`, leases,
quarantine and healing, deadlines and cancellation, the execution policy, error mapping. Under it,
three internal steps get a native implementation chosen per call:

| Part       | TypeScript step replaced                                                                                                                                                                         | Today's processes                                                                          | Native result crossing N-API                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `snapshot` | `withSnapshotIndex` + `snapshot` tree building (`snapshot-index.ts:13`, `checkpoints.ts:22`, `nested.ts:48`), used by checkpoints, live diffs, `workspaceRevision`, `captureChanges`             | `rev-parse`, 2× `ls-files`, `read-tree`, `update-index`, `add`, `write-tree`               | `{ tree, nested: [] }` or `{ fallback: reason }`                |
| `refs`     | `Repository.commit` (rev-parse, `repository.ts:156`), `branchHead`, `listBranches`, `branchRefs`, `Repository.worktrees` (`repository.ts:90`, `remote-branches.ts:34`, `:150`, `actions.ts:274`) | `rev-parse`, `check-ref-format`, `for-each-ref`, `symbolic-ref`, `remote`, `worktree list` | small plain objects; ref names and paths as `Buffer`            |
| `status`   | `Repository.state` (`repository.ts:113`)                                                                                                                                                         | `status --porcelain=v2`                                                                    | the parsed shape `parseStatus` returns today, paths as `Buffer` |

Everything else keeps running Git: writes, remotes, patches, history, restore, merges, transfers.
Patch text stays Git's: `git diff` runs on the trees the native snapshot wrote, as it does on the
trees the CLI wrote.

### 2. Native results are plain values; TypeScript decodes paths

- No JSON crosses. Results are napi objects of strings, numbers and booleans, small by
  construction (a tree id; a list of changed entries; a list of refs). The `ace-json` rules don't
  arise: nothing here is JavaScript-shaped JSON.
- **Rust fetches, TypeScript shapes** (ADR 0222's rule): path and ref bytes cross as `Buffer`s
  and go through the existing `decode` with `pathSchema`/`refSchema` (`decode.ts:7`, `:24`), so a
  path that the CLI path would reject as `malformed_output` is rejected the same way, by the same
  code. Ids cross as lowercase hex strings, which `hashSchema` checks as today.
- Errors are a `thiserror` enum mapped in the binding to `GitError` codes: `not_a_repo`,
  `unsupported_repository`, `filesystem_error` (with the `errno` name), `git_cancelled`,
  `git_timeout`, `git_failed`.

### 3. A native step either matches Git exactly or hands the call back to the CLI

Each native step first reads the repository's facts it depends on (cheaply, in process) and, when
any is outside what it reproduces exactly, returns `{ fallback: reason }`; the TypeScript then
runs today's CLI step in the same `serial` turn and lease. A fallback is never an error and never
a partial result. Reasons are counted per kind in `resourceUsage()` so the native share is
measured, not assumed. The initial fallback list (the porting guide owns the exact list):

- **Snapshot**: a filter driver (`filter.<x>.clean`/`process`) that an attribute selects for any
  path, in a root that isn't protected (in a protected root drivers are off on both paths);
  `core.safecrlf=true` with an eol conversion in effect (Git would refuse; outside Windows ace
  passes it through, `snapshot-index.ts:28`–`:31`); nested checkouts or gitlinks found by the
  scan (their flattening and object transfer stay on the CLI path); `extensions.refStorage`,
  split index, `core.sharedRepository`, index versions or extensions `gix` doesn't read; sparse
  checkouts keep failing `unsupported_repository` on both paths.
- **Refs and worktrees**: reftable; a worktree entry whose locked or prunable reason `gix` can't
  produce as Git words it.
- **Status**: `core.fsmonitor` in a person's root (Git may answer faster from the monitor);
  submodules; anything the snapshot list names.

Exactness inside the native path means: the same file set (HEAD ∪ index ∪ untracked nonignored,
with `core.ignorecase`, `info/exclude` and `core.excludesFile`; global attributes ignored in
protected roots), the same modes (`core.fileMode`, `core.symlinks`, executable bits, symlink
targets), the same blob bytes after Git's built-in conversions (`text`, `eol`, `core.autocrlf`,
`ident`, `working-tree-encoding`, via `gix-filter`), the same canonical tree encoding, and the same
treatment of hidden-flag entries and unresolved conflicts as the temporary index gives today.

### 4. Where native work runs, and how it stops

- Each native call is one task on the tokio blocking pool of the addon's runtime (ADR 0223 §4),
  never on the JS thread; at most two run at once, and each uses at most four threads inside
  (`gix`'s `thread_limit`, and the hashing fan-out), matching the shared-machine rule.
- **Cancellation and deadlines are cooperative and settle late, never early.** The TypeScript
  passes a cancel handle; aborting or the call's deadline sets an `AtomicBool` that `gix`'s status
  and dirwalk already take (`should_interrupt`) and that the hashing loop checks between files.
  The promise settles only after the task has returned, so the call fails `git_cancelled` or
  `git_timeout` with nothing left running: the lease is released truthfully (a better cleanup
  receipt than a killed process's `unconfirmed`).
- **Leases.** The snapshot writes blobs and trees into the repository's object store (atomic
  temp-file-and-rename, as Git does; no ref, no index). It runs inside the same `serial` turn and
  takes the same write lease as the CLI `git add` does today, held by the daemon's own process;
  the TypeScript releases it when the native promise settles. Quarantine, healing and admission
  are unchanged.
- **Trust.** The repository is opened with `gix`'s owner checks matched to Git's `safe.directory`
  (a refusal maps to the CLI's code), no hooks (`gix` runs none on these paths), no fsmonitor, no
  filter driver (fallback instead), and the execution policy's overrides of `non-executing.ts:35`
  applied as configuration overrides in protected roots.

### 5. Crates

In the `native/daemon` workspace: one crate, `ace-git`, and one binding module,
`ace-daemon-node/src/git.rs`.

- **`gix`** 0.91 (MIT/Apache-2.0), `default-features = false`, features `status`, `parallel`,
  `revision`, `sha1`, `sha256`, `attributes`, `excludes`, `dirwalk`. It is the maintained,
  pure-Rust Git implementation with status, dirwalk, filters, refs and worktrees; it opens SHA-1
  and SHA-256 repositories, as `hashSchema` accepts both. Not `pack-cache-lru-static` (MPL-2.0
  dependency).
- **`thiserror`** for the error enum; **`tokio`** from the workspace (the blocking pool).
- Rejected: **`git2`/libgit2** (C, its own semantics differ from Git's in the same places `gix`
  does, and it would add a C build to every platform); a Rust process layer for the remaining Git
  calls now (the CLI path's cost is Git's work, and `cli.ts` is 1,143 lines of lease and kill
  rules that ADR 0223's supervisor covers later through the existing `processRuntime` port).

### 6. The switch and the cross-mode gate

- `ACE_GIT=<parts>` (comma list of `snapshot`, `refs`, `status`), read once in
  `packages/provider-kit/src/native-switches.ts` (ADR 0223's switch module), independent of
  `ACE_STORE` (no SQLite). Unset is today's TypeScript. Set with the addon missing, the daemon
  refuses to start, as the other switches do; a per-repository fallback (section 3) is not that.
- **Cross-mode.** A repository's state is Git's own objects and refs, so the rollback risk is a
  native tree that differs from the CLI's for the same files, which would show changes nobody
  made. `ACE_NATIVE_CROSS=ACE_GIT` alternates the backend per call within a process (even calls
  native, odd calls CLI), so a checkpoint written by one backend is listed, diffed and restored by
  the other inside one test. Its list: `checkpoints.process`, `snapshot-index.process`,
  `workspace-revision.process`, `nested.process`, `diff.process`, `transfer-capture.process`,
  `untracked-links.process`.

### 7. The forge stays TypeScript

`@ace/forge` does not move. Its requests are the person's CLI by rule (ADR 0002); the daemon's
share of a request is 1–3 ms; its 44 process tests prove the `gh api` argv-and-reply contract,
which a Rust port would have to reproduce for no measured gain; and 13 of its entries run in the
browser. If the owner extends ADR 0002 to let the daemon hold a host token in memory (question 3),
the per-request CLI start and TLS handshake can go, and that change is a transport behind
`GhApi`/`CommandRunner` that the forge porting guide describes; it is language-neutral (Bun's
`fetch` keeps connections alive), so it stays TypeScript unless measured otherwise.

### 8. Phases, each shippable alone

| Phase | What moves                                                                                      | Switch                  | Needs                       | Proven by (class (a) files, behaviour.md §12)                                                                                                                            | Ships when                                                                                                 |
| ----- | ----------------------------------------------------------------------------------------------- | ----------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| G0    | `ace-git` skeleton, binding stub, the switch, `cargo deny` with `gix`; no behaviour             | none                    | ADR 0223 E0 (switch module) | `check:daemon-native`                                                                                                                                                    | always                                                                                                     |
| G1    | Snapshot tree building and the nested-checkout scan                                             | `ACE_GIT=snapshot`      | G0                          | the snapshot, restore-audit, non-executing and lease rows (38 files); the G1 cross-mode list                                                                             | `createCheckpoint` on this repository at most a third of the CLI's wall, no more total CPU; zero (a) diffs |
| G2    | Ref, branch and worktree-list reads                                                             | `ACE_GIT=refs`          | G0                          | the status, worktree and remote rows (22 files)                                                                                                                          | no slower than the CLI per call; zero (a) diffs                                                            |
| G3    | Status                                                                                          | `ACE_GIT=status`        | G1, G2                      | the status and source-control row, `changed-files-regressions`, `client-actions`, `malformed.process`, the non-executing row, and the 39 daemon files using `GitService` | lower wall and no more CPU than the CLI here and on a 100,000-file synthetic repository                    |
| G4    | Git processes through ADR 0223's supervisor, via `processRuntime.spawn`; no `GitService` change | `ACE_SUPERVISOR=native` | ADR 0223 E2 default-on      | the process-boundary and lease rows (section 2 and 3 files)                                                                                                              | with E2                                                                                                    |

G1 and G2 can be built in parallel. G3 is built only after G1 and G2 have shipped and is the
owner's call (question 4). Default-on per part after one release with no (a) failure and the
fallback counts reviewed; the CLI steps stay as the fallback path, so the TypeScript is not
deleted.

### 9. Tests move, they don't multiply

As ADR 0223 §9. The (a) files are the proof and are not edited; each runs alone, switch on and
off. The (b) files all cover modules that stay TypeScript and run unchanged; no case moves.
A native step gets `#[cfg(test)]` tests only for behaviour no TypeScript test covers, and the
commit says which (expected: the fallback detection of section 3, whose triggers today's tests
don't set up). No parity harness: the cross-mode gate compares nothing, it runs the existing
tests with the backends interleaved.

## Consequences

- On a large repository a send stops waiting about 1.3 s for its checkpoint, and live diffs and
  after-turn checkpoints get the same saving; the daemon's JS thread loses the nested scan's
  `stat` storm (about 150–250 ms of CPU per snapshot).
- Two implementations of snapshot tree building exist for good: the native one and the CLI one it
  falls back to. Their agreement is what the cross-mode gate and the fallback list protect; a
  configuration the native one doesn't model goes to the CLI rather than being guessed.
- A `gix` bug in a native step affects only the parts switched on, and a panic is caught at the
  binding (`catch_unwind`) and thrown as `git_failed`; it never takes the daemon down.
- The daemon's peak memory grows while a native snapshot runs (the probe peaked at 50 MB for the
  whole process; `git add` peaks at 36 MB in its own process today).
- `@ace/forge` keeps all its code and tests in TypeScript; its cost stays the CLI per request
  unless question 3 changes the credentials rule.

## Questions for the owner

1. **A stat cache for snapshots?** G1 keeps today's rule (hash every file: about 230–490 ms of
   hashing on this repository instead of 1.2 s). A daemon-owned cache of blob ids keyed by
   (device, inode, size, mtime and ctime in nanoseconds) from the previous snapshot of the same
   root, with Git's racy-entry rule, would make snapshots proportional to what changed (tens of
   milliseconds), at the cost of trusting file metadata for the bytes of a checkpoint.
   Recommended: not in G1; decide on G1's numbers.
2. **Permanent CLI fallback.** Accept that the snapshot and status paths keep a CLI fallback for
   repositories with filter drivers, nested checkouts, reftable, split index or a shared
   repository (section 3), with the native share reported in `resourceUsage()`? Recommended: yes.
3. **Host tokens in memory?** Keep one CLI process per host request (ADR 0002 as it is;
   recommended), or extend ADR 0002's in-memory exception, today only for providers' usage
   endpoints, to host API calls: the daemon reads `gh auth token` (and the other CLIs' equivalents)
   per batch, never stores it, and keeps an HTTPS connection alive, saving about 31 ms of CPU,
   41 MB of transient memory and a TLS handshake per request? Today's 44 process tests fake the
   CLI, so this needs a local fake host to test against: new tests.
4. **Status in Rust (G3)?** Its gain here is 130–160 ms of wall per status at equal CPU, on reads
   that run one to three times a minute per project, against the risk of a second implementation
   of status semantics. Build it after G1 and G2 ship, or stop at G2? Recommended: decide after G2.
5. **Large repositories to measure on.** The numbers above are on one 23,528-file repository.
   Which of the person's repositories (read-only, through a local clone) should G1 and G3 be
   measured on before default-on?
