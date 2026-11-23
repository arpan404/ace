# 0224: `@ace/git` and `@ace/forge` move to Rust behind the same interfaces

Date: 2026-11-23. Status: proposed. Decided by: the owner decided that both packages move
(2026-11-23, "port all six anyway"), after the measurements below; the design is pending the
owner. Native snapshots (G6) are blocked until the restore-safety and tree-identity gate of §7
passes.

## Context

The owner is moving the daemon to Rust: the store
([ADR 0222](0222-the-event-store-moves-to-rust-behind-the-same-store.md)), the engine and adapters
([ADR 0223](0223-the-engine-and-adapters-move-to-rust-behind-the-same-interfaces.md)), and now
`packages/git` (status, diffs, checkpoints, worktrees, branches, commits, pushes: a `git` process
per step today) and `packages/forge` (GitHub, GitLab, Gitea/Forgejo, Bitbucket and Origin through
the person's CLIs). Their contracts are [docs/git/behaviour.md](../git/behaviour.md) and
[docs/forge/behaviour.md](../forge/behaviour.md). ADR 0222's lessons apply: Rust that must
reproduce JavaScript-shaped output diverges unless it is built on `ace-json`; a Rust result that
JavaScript parses again can be slower than TypeScript; the existing tests are the proof; measure
first.

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

**Equivalent work for a narrower snapshot split** (same fixture, Git steps on a temporary index,
load 23–31). The 230–490 ms hashing figure above excludes conversion, object writes and queueing;
a split in which Git still seeds, lists and assembles adds these Git steps: `ls-files --cached
--others --exclude-standard` 60 ms, `check-attr --stdin` for six attributes over 23,546 paths
60 ms, `cat-file --batch-check` of 23,527 ids 90 ms, `update-index --index-info` of 23,527 rows
90 ms, and `write-tree` 300 ms once every row is rewritten (32 ms when only changed rows are,
because the cache tree from `read-tree` stays valid). Restricted to changed rows, the estimate is
0.6–0.8 s per snapshot against 1.6 s; it is an estimate until G6's bench measures it.

### Which parts would gain from Rust (recorded before the owner's decision)

- **Gain: snapshots**, by hashing in parallel and scanning for nested checkouts off the JS
  thread; about 2× on this repository once equivalent work is counted.
- **Small gain: ref and branch reads** (10–20 ms and one to five processes per call).
- **Modest gain, real risk: status** (130–160 ms of wall at equal CPU).
- **No gain from the language**: writes, remotes, merges, patches, history and every host request;
  their cost is Git's or the CLI's own work and the network. The daemon spends 1–3 ms of a host
  request.

The owner decided to move both packages whole anyway, so that the daemon's logic lives in one
language. The gains above decide the order and what may use `gix`; they don't decide whether.

### Facts the design must respect

1. **ace never holds host or Git credentials** (ADR 0002, unchanged: question 3 below). Remote Git
   operations and every host request run the person's CLI, one process per request.
2. **Nothing of a protected root executes** (behaviour.md §4), including system attributes and
   lazy fetches (`GIT_ATTR_NOSYSTEM`, `GIT_NO_LAZY_FETCH`, `non-executing.ts:113`–`:130`).
3. **Git's output is validated strictly** (behaviour.md §10); host data leniently (forge
   behaviour.md §5).
4. **Writers are fenced by leases** that outlive a killed process (ADR 0068).
5. **Restore trusts its safety tree.** `restoreCheckpoint` captures a safety checkpoint and then
   moves the checkout from that tree to the target (`restore.ts:17`–`:30`, `:61`–`:70`): a wrong
   safety tree loses files. Every checkpoint is a future safety or target tree.
6. **Held directories.** Some calls run Git inside a held directory descriptor instead of by path
   (`directoryFd`, `repository.ts:113`–`:130`, `:156`–`:176`; callers `projects.ts:635`,
   `repository-publications.ts:151`, `transfers/landing-place.ts:79`), so a renamed or replaced
   path can't redirect them.
7. **Tests inject the process runtime.** 25 of git's test files inject `processRuntime` members
   (49 `spawn` substitutions, `scheduleTimeout`, `signalGroup`, `locateGit`, `cleanupSupervisor`,
   `fileClock`), and 19 inject a fake `gitBinary`; 26 forge test files inject a JS runner and 40
   use `fakeGh`, a real fake executable.
8. **The browser uses forge's pure entries** (13 subpaths, about 1,300 lines), and the forge's own
   classes use the same modules internally.
9. **The machine is shared**: native work is bounded in threads.

## Decision

### 1. Same interfaces, a Rust core behind each, switch off by default

| Package | Boundary kept in TypeScript                                                                                                               | Rust        | Switch (off by default)                                                                            | Needs                                                     |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| git     | `GitService`, `GitTransfer`, every export of `.` and `./remote-url` (behaviour.md §1); error classes `GitError`, `WorktreeRemovalRefused` | `ace-git`   | `ACE_GIT=<parts>`: `refs`, `core`, `reads`, `writes`, `checkpoints`, `snapshot-hash`, `status-gix` | `ACE_SUPERVISOR=native` for every part but `refs`         |
| forge   | every export of the 15 entry points (forge behaviour.md §1); `ForgeError` and its subclasses                                              | `ace-forge` | `ACE_FORGE=<hosts>`: `github`, `gitlab`, `tea`, `bitbucket`, `origin`; `ACE_FORGE_STORE=native`    | `ACE_SUPERVISOR=native`; `ACE_STORE=native` for the store |

- As in ADR 0223 §1: each exported class or function is the native one when its switch names it,
  chosen per instance through `packages/provider-kit/src/native-switches.ts`; set with the addon
  missing, the daemon refuses to start; unset is today's TypeScript, which stays as the fallback
  until one release after default-on.
- Signatures, result shapes, error codes and classes (`instanceof` holds: the binding throws the
  TypeScript classes), timing (what is synchronous stays synchronous: `protectWorktree`,
  `mutationState`, `forgeCapabilities`) and callback order are contract.

### 2. Processes go through the supervisor; ports stay injectable

- **Every Git and host-CLI process** the Rust cores start goes through `ace-supervisor`
  (ADR 0223 E2): group or job containment, identity, the inventory journal, stop plans, bounded
  capture. The git core keeps its own rules on top: the environment of `cli.ts:714`–`:734`
  (`GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`, `GIT_OPTIONAL_LOCKS=0` for reads, the askpass rules),
  `--no-pager`, the 64 MiB capture, `stopAtCapture` and `stopAfterMs`, deadlines, `unconfirmed`
  receipts; the forge core the runner's (forge behaviour.md §2): its environment, 4 MiB, 30 s,
  tail mode, network-failure matching, and nothing of stderr, argv or environment leaving it.
  Windows' gate process (`command.ts:67`–`:79`) is replaced by the supervisor's job object.
- **Ports.** Every `GitProcessRuntime` member (`types.ts:28`) and the forge's injected
  `CommandRunner` are ports of the Rust core. Defaults are native. An injected member is called
  back on the JS thread, as ADR 0223 §7 calls a `JsSession`: an injected `spawn` returns a
  `ChildProcess`, which the binding bridges (stdin writes, stdout and stderr chunks in order, the
  exit, the pid for group signals) so the core reads it as it reads a supervised child; an injected
  runner is awaited like the native one. So the 25 git files that inject the runtime and the 26
  forge files that inject a runner prove the Rust cores unchanged. An injected `platform` selects
  the Windows strategy at run time, as TypeScript does, so the taskkill tests keep running on
  macOS.
- **Held directories.** A call with a `directoryFd` runs its Git in that directory by descriptor
  (the supervisor spawns with that working directory descriptor, `fchdir` before `exec`), never by
  path; until the supervisor offers that, such calls keep the TypeScript path. `gix` never opens a
  held directory.

### 3. JS-visible output goes through `ace-json`; strings stay JavaScript strings

- Every value a TypeScript caller sees is serialized by `ace_json::ser::to_string` and parsed once
  by the binding's shell with `JSON.parse`; strings that came from JavaScript or from JSON (comment
  bodies, titles, messages, paths a caller passed) are `ace_json::JsString`, so lone surrogates and
  UTF-16 lengths survive. Git's bytes become strings exactly as `Buffer.prototype.toString("utf8")`
  makes them (WHATWG replacement of maximal invalid subparts, which `String::from_utf8_lossy`
  matches) before the same schemas as today decide what is valid.
- Shapes are the TypeScript's: a value TypeScript ran through a Zod `parse` comes out in the
  schema's key order with unknown keys stripped where Zod strips and kept where the schema keeps
  `raw`; `redactData`'s key suffixing (`redact.ts:9`) is kept; objects TypeScript freezes
  (`immutable`, 23 sites in forge) are frozen by the shell after parsing. Output types for
  `@ace/protocol` values come from `ace-protocol` (ADR 0223 §2); forge's own schemas are mirrored
  field for field in `ace-forge/src/schema/`.
- Host replies are parsed with `ace_json::parse` (`JSON.parse`'s numbers, duplicate keys and lone
  surrogates), never `serde_json`.
- Large strings (patches up to `maxPatchBytes`, log tails, file contents) cross as one JSON string
  field; the forge transport bench and the git ops bench must show the crossing is no slower than
  the TypeScript within noise (lesson 2).

### 4. Git: the CLI stays the executor; `gix` only where proven exact

The git core is a port of the TypeScript orchestration (per-root `serial`, `ReadGate(2)`, leases,
quarantine and healing, the execution policy, config facts, error mapping) and of its parsers, and
it keeps running Git for everything it runs Git for today. `gix` is used only for:

- **`refs`** (G1): `rev-parse --verify <ref>^{commit}` and the unborn check
  (`repository.ts:156`–`:176`), the refs behind `branchHead`'s lookup (its `check-ref-format`
  stays Git), `listBranches`, `branchRefs`, and `worktree list`. Each keeps its own caller's
  contract and decoder (§6, review point 5).
- **`snapshot-hash`** (G6): blob ids of the conversion-free part of a snapshot, with Git still
  seeding, listing, deciding and assembling (§5).
- **`status-gix`** (G7, after G1, the owner's call): status for display reads only.

Everything else (commits, stage/unstage, merges, stack replays, worktrees, branches, pushes,
fetches, clones, transfers, patches, history, restore) runs the person's Git through the
supervisor, parsed in Rust with the strict decoders ported from `parse-*.ts`.

### 5. Snapshots: Git decides, Rust only hashes what needs no conversion

Today's snapshot, step for step (`snapshot-index.ts:13`–`:50`, `checkpoints.ts:22`–`:88`):
S1 sparse refusal; S2 temporary index and settings; S3 `rev-parse HEAD^{tree}` ∥ `ls-files --stage`
of the person's index; S4 `read-tree` HEAD; S5 `update-index --index-info` of the person's rows
at stage 0; S6 `ls-files --stage` of the result (`seeded`); S7 nested-checkout discovery and the
excluded set; S8 gitlinks removed; S9 the pathspec set; S10 `git add --all`; S11 nested
flattening; S12 the gitlink refusal; S13 `write-tree`.

In the Rust core (G5) every step is ported as is: the same commands, the same order, the same
environment. G6 (`snapshot-hash`) changes only S9–S10, and only on the native path:

- **N9.** Git lists the candidate set `C`: `ls-files -z --cached --others --exclude-standard` on
  the temporary index with the step's environment, filtered by the excluded set as
  `checkpoints.ts:59`–`:64` filters it. Git's ignore precedence, `core.ignorecase` and
  `core.precomposeUnicode` have already applied to `C`.
- **N10.** Whole-snapshot preconditions, read through Git with the same environment (config
  facts): `core.fileMode=true`, `core.symlinks=true`, `core.autocrlf=false` or unset, not Windows,
  the default Git binary and no injected `spawn`. Otherwise S10 runs as today (reason `config`).
- **N11.** Git reports attributes: `check-attr -z --stdin text eol crlf ident filter
working-tree-encoding` over `C`. The set `L` that Git adds itself is: every path with any of
  those six specified, other than `text` unset; every path whose person's-index row was not stage
  0; every path that is an ancestor or a descendant of a seeded path of the other shape (file
  versus directory); when `core.ignorecase` is true, every path that case-folds onto another; when
  `core.precomposeUnicode` is true, every non-ASCII path.
- **N12.** Rust, for each path of `C \ L` (at most four threads), opens the checkout root once,
  checks it is the device and inode `serial` resolved, and reads root-relative without following
  symlinks (`cap-std`): an ancestor that is not a real directory, a missing path, or anything but a
  regular file or symlink goes to `L`; a regular file's id is the blob hash of its bytes and its
  mode `100755` when the owner execute bit is set, else `100644`; a symlink's id is the hash of its
  target and its mode `120000`; a path whose (device, inode, size, mtime, ctime) changed across
  the read goes to `L`. Rust reads no index, no config, no attributes and writes nothing; it
  returns only rows that differ from `seeded` or are new.
- **N13.** Git checks the returned ids (`cat-file --batch-check`); the missing ones are written by
  Git (`hash-object -w --no-filters --stdin-paths`), and the ids Git prints must equal Rust's or
  the native attempt is discarded (reason `hash_mismatch`).
- **N14.** Git takes the rows (`update-index -z --index-info`, changed rows only, so the cache
  tree stays valid) and adds `L` itself (`add --all --pathspec-from-file`, `:(literal)` paths).
- **N15. Revalidation, after N14 and before S11.** Every input the attempt observed is read
  again and compared:
  - from S3: HEAD's target and tree id, and the person's index file (device, inode, size, mtime,
    ctime); the index is read only by Git (`ls-files`), so a published index is still read while
    another Git holds `index.lock`, as today (`snapshot-index.process.test.ts:217`);
  - from S7 and N9: the nested scan, and the candidate set `C` itself (`ls-files --cached --others
--exclude-standard` again; any added, removed or reclassified path is drift);
  - the ignore inputs: every `.gitignore` in a directory of `C` or its ancestors,
    `info/exclude`, and `core.excludesFile`;
  - from N10–N11: every `.gitattributes` in those directories, `info/attributes`, the global
    attributes file (`core.attributesFile`, `/dev/null` in protected roots), the system attributes
    file (unless `GIT_ATTR_NOSYSTEM` is set, as in protected roots), and the config sources' stamp;
  - from N12: the (device, inode, size, mtime, ctime) of every path Rust hashed, statted again
    now, not only across its read;
  - from N14: the same tuple for every path of `L` that Git added, taken just before N14 and again
    now, so the bytes Git read are the bytes still there (a changed tuple is drift; ctime can't be
    set back by a tool, so an edit that restores mtime still shows).

  Any difference is drift: the attempt's temporary index is discarded and the snapshot restarts
  **from S1** (sparse check, a new temporary index, a fresh S3 of HEAD and the index), on the CLI
  path, once (reason `inputs_changed`). After S11 nothing reads the parent checkout's files again,
  so the tree is the checkout as of N15's reads; a change after N15 is a later change, as for any
  snapshot.

- All writes are Git processes under the lease the CLI path takes; the native step adds no writer.

### 5a. Restore's safety capture (hard rules)

The ace lease fences ace's own Git, not an editor, an agent's shell or another Git client. Restore
moves the checkout from the safety tree to the target with `read-tree --reset -u`
(`restore-nested.ts:55`–`:79`), which overwrites, without checking, a path whose bytes changed
after the safety capture. So:

1. **Restore's safety capture always runs the CLI snapshot (S1–S13 with `git add`)**, in G5 and
   after G6, whatever `ACE_GIT` says. `snapshot-hash` never produces a safety tree. Changing this
   needs an amendment of this ADR.
2. **The guard covers every path `read-tree --reset -u` may touch, by raw bytes and stat.** Restore
   loads the owned safety tree into a temporary index with no stat data and resets it to the
   target (`restore-nested.ts:63`–`:81`), so Git may rewrite an entry that is the same in both
   trees if its file drifted. The touch set of each repository is therefore every path of its owned
   safety tree and of its owned target tree, with their ancestors, not only the differences.
   - **Witness.** The core stats every touch-set path (type, mode, size, mtime and ctime in
     nanoseconds, device, inode) immediately before the safety capture's S1 and again right after
     its S13 (before S1 the safety tree isn't known yet, so that stat covers the target's paths and
     the checkout's listed files, `ls-files --cached --others --exclude-standard`; a safety-tree path
     missing from it is drift); a path whose tuple moved in between is drift during the capture
     (retry). The second
     stat, with a hash of each regular file's raw bytes and each symlink's target, is the witness.
     Raw bytes, not Git's filtered blob: two byte sequences that normalise to one blob (CRLF and
     LF under `text=auto`) are different witnesses, and on Windows the exact-byte path restores
     `checkpointBytes` trees (`checkpoint-bytes.ts:101`, `:158`), which a raw witness matches.
   - **Check.** Immediately before the first write, the core stats every touch-set path again;
     a path whose tuple moved is re-hashed raw and is drift unless its bytes, type and mode equal
     the witness (so a bare `touch` is not drift). The person's index file (raw bytes) and HEAD
     must equal the capture's.
   - **On drift**: discard the plan, take a new safety capture from S1, and check again, twice at
     most; then fail without writing anything (today's error, with `safetyCheckpointId`).
3. **Nested restores check everything before writing anything.** Today the parent's
   `read-tree --reset -u` runs before any child is processed (`restore-nested.ts:63`–`:86`), so a
   child's drift would be found after the parent changed. The restore becomes plan, then check,
   then apply: for the whole hierarchy (`withNestedWorktrees`, child locks held throughout) the core
   computes every repository's owned trees and subtrees and copies the objects children need
   (`transferTree`, object writes only), then runs the check of rule 2 over every repository's touch
   set, and only when all pass does it write, parent first. Just before each child's write its own
   touch set is checked once more; a child that drifted while the parent was written stops the
   restore there with the safety checkpoint as the recovery point (the error carries
   `safetyCheckpointId` and the repositories already written), rather than overwrite.
4. **This guard is new behaviour for both backends**: it lands in TypeScript first, with its own
   tests, in its own change; G5 ports it after. Until it lands, G5's restore is today's, step for
   step, and restore stays CLI-only (rule 1).
5. **The window left** is between a repository's last check and Git's writes in it (milliseconds,
   proportional to its touch set). It can't be fenced without the other writer's cooperation; the
   daemon's callers keep pausing their own agents while restoring (README, "All operations
   serialize…"), and the safety checkpoint stays the recovery point.
6. **Normalisation is not drift but can still change bytes.** Where `text=auto` or eol attributes
   apply, Git's checkout of an unchanged entry may rewrite a CRLF file as LF on POSIX (Windows
   already restores exact bytes). The witness shows it; whether restore should keep the raw bytes
   everywhere is question 8.

### 6. Refs and worktrees keep their callers' contracts

- Worktrees: the core emits the records `worktree list --porcelain -z` would, and `parseWorktrees`'
  Rust port decodes them with its own rules, absolute paths included (`parse-repository.ts:36`). A
  worktree whose prunable or locked reason `gix` can't word as Git does falls back for that call.
- Branch listings: the core emits `for-each-ref`'s lines for `remote-branches.ts:79`'s format and
  sort (`-committerdate`, then `refname`, `--count`), applies the 8 MiB cap to those bytes
  (`output_too_large`, `:87`–`:89`), and the `parseRef` port (`:97`) skips what
  `BranchRef.safeParse` skips (`:103`, `:115`). No decoder is shared between callers.
- Reftable repositories fall back.

### 7. The gate: tree-identical to the CLI on the same fixtures, both ways

No existing test compares the two backends. `roundTrip` (`snapshot-index.process.test.ts:37`–`:51`)
checks the checkout's bytes after a restore through whichever backend ran; a tree that differs
only in a mode or a line ending the checkout normalizes back, or that holds an extra untracked file
the restore then leaves, passes it. Since restore trusts the safety tree (fact 5), the gate adds the
minimum that compares, and it adds no test case or fixture: the existing ones are what is compared.

- **Two logs, compared separately.** With `ACE_GIT_DIGEST_LOG`, the shell appends, after every
  write and every failed write, two records: the **state digest** (below) and the **completion
  record** (the returned value through `ace-json`, with commit ids replaced by their position in
  the test's commit order; the error code and the names of `details`' keys; the cleanup receipt's
  status), compared by value: messages exactly; every `details` value, including
  `safetyCheckpointId` and other ids, after the same position mapping as commit ids; paths
  relative to the fixture. `scripts/native-git-digest.ts <file>` runs the file with the parts off and on, with the
  clock and ids the tests already inject, and fails unless both logs are identical, record for
  record. A write part ships only when every file of its proof list passes.
- **The state digest** is read with Git and the filesystem, never with a fresh snapshot, so
  nothing is normalized:
  - refs: HEAD (symbolic target, or detached), every ref under `refs/heads`, `refs/remotes`,
    `refs/tags`, `refs/stash` and `refs/ace`, each commit written as tree id, parents (as positions
    or fixture ids), author and committer names and emails, and message bytes; dates only where the
    test injects the clock;
  - the person's index: `ls-files --stage -z` (mode, id, stage, path, so conflict stages show) and
    `ls-files -v -z` (assume-unchanged and skip-worktree flags); and, wherever the operation
    promises preservation (every snapshot and checkpoint, restore, failed writes), the raw bytes of
    `.git/index`, any `sharedindex.*`, `HEAD`, `packed-refs`, the loose ref files and the stash
    reflog, byte for byte;
  - operation state: presence and bytes of `MERGE_HEAD`, `MERGE_MSG`, `MERGE_MODE`, `AUTO_MERGE`,
    `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `rebase-merge/`, `rebase-apply/`, `sequencer/`;
  - the checkout: every path outside `.git`, ignored files included, with type, mode bits, a hash
    of its raw bytes, and symlink targets;
  - worktree registrations (`worktree list --porcelain -z`, paths relative to the fixture) and
    `config --local --list`;
  - for pushes and fetches, the same ref listing of the fixture's remote.
- **Operation postconditions** each write must also meet, checked from the digest: a commit moves
  only HEAD's branch to a commit whose parents are the old HEAD (and `MERGE_HEAD` for a merge
  commit) and leaves no operation state; stage and unstage change only the index rows of the
  named paths; a merge start writes `MERGE_HEAD` and the conflict stages and an abort removes them
  and restores index and checkout; `takeSide` and `writeResolution` collapse that path's stages; a
  fetch changes only remote-tracking refs; a worktree removal leaves its branch; a checkpoint adds
  its two refs and leaves the person's index, HEAD and stash byte for byte; a restore leaves HEAD
  and the index, and the checkout's raw bytes equal the target's checkout with ignored files kept;
  a failed write leaves the digest as it was before the call, unless today's TypeScript leaves a
  documented partial state (restore's safety ref), which must then be identical too.
- **Snapshot verify.** `ACE_GIT_VERIFY=strict` makes every native snapshot also run S9–S13 on the
  CLI path over a copy of the same temporary index, in the same `serial` turn, and fail on any
  difference of tree id or error code, naming the differing paths (`git diff-tree`). G6 passes
  every snapshot (a) file under it. `ACE_GIT_VERIFY=shadow` does the same in a daemon, keeps the
  CLI's tree, and counts differences: the measurement on this repository and the main checkout's
  read-only clones (question 5) runs in shadow.
- **Both directions, per operation edge that actually occurs.** `ACE_NATIVE_CROSS=ACE_GIT`
  alternates the backend per call; `scripts/native-cross.ts` runs each file twice, starting native
  and starting TypeScript. The log keys every record by operation (`createCheckpoint`,
  `listCheckpoints`, live `diff`, `restoreCheckpoint` as safety producer and as target consumer,
  `workspaceRevision`, `captureChanges`, …) and names each checkpoint's producer and each use's
  consumer. The script derives from the switch-off run which producer → consumer edges the file
  exercises (checkpoint → list, checkpoint → live diff, checkpoint → restore), and requires both
  backend directions for each of those edges over the two runs; it requires no edge the file never
  exercises (`snapshot-index.process` has no diff consumer, so none is required there). List:
  `checkpoints.process`, `snapshot-index.process`, `workspace-revision.process`, `nested.process`,
  `diff.process`, `transfer-capture.process`, `untracked-links.process`, `audit-restore.process`,
  `credential-restoration.process`.
- **Native coverage per test and per operation.** Every record names the operation, the backend
  selected, the one that completed it and any fallback reason. For each test and each operation
  that selected native, at least one call of that operation completed natively; another operation's
  native completion never counts for it. Expected fallbacks are listed per test and operation, with
  reason and count; any other, or a listed one that didn't occur, fails.
- **Strict verdicts for the paths exercised.** Under `ACE_GIT_VERIFY=strict` every verified call
  records its verdict and how its rows were produced (hashed by Rust, added by Git as `L`, or the
  whole call fallen back). A test counts as `snapshot-hash` coverage only if one of its calls
  compared equal with at least one Rust-hashed row; a file whose snapshot tests all ran with zero
  Rust-hashed rows fails as vacuous. The same applies to G7's status (rows from `gix` versus a
  fallback).
- **CLI contract tests stay CLI contract tests.** Files that inject a fake `gitBinary`
  (`malformed.process.test.ts:24`, `:66` and the 17 others) prove the Rust parsers against the
  same fake output; `snapshot-hash` and `status-gix` never run with a non-default binary, so the
  fake stays what is exercised.
- Justification against "tests move, they don't multiply": the digests, postconditions and verify
  mode compare
  outputs of the existing tests and add none; they guard data a person can lose, which outranks
  the rule's purpose (no duplicate suites).

### 8. Forge: the same CLIs, driven from Rust

- `ace-forge` ports the runner, `GhApi` (`--include` parsing, ETag and `If-Modified-Since`, the
  GraphQL cache keyed by SHA-256, `x-poll-interval`), write classification and `MutationDispatch`
  (dispatch is "the CLI process started", from the supervisor's spawn result), read-only
  admission, pinned identities, redaction, the readers and writers of the five hosts, review and
  status revisions, list caches, media, and errors, and drives `gh`, `glab`, `tea`, `bkt` and
  `origin` one process per request. No token is read or stored; nothing else changes about
  credentials.
- **The pure entries.** The forge's classes use the 13 browser modules internally, so `ace-forge`
  has their Rust port (`ace-forge/src/pure/`); the TypeScript modules stay for the browser. The
  daemon's own imports of them get the native ones with the switch on, so the 9 pure (a) files run
  against both, which is what keeps the two copies equal. Building them once as WebAssembly for the
  browser is question 6.
- **`ForgeStore`, `ForgeIntents`, reply receipts** move onto `ace-store`'s connection with the same
  tables and rows, behind `ACE_FORGE_STORE=native` (needs `ACE_STORE=native`); rows written by one
  backend are read by the other (ADR 0223 §8's per-boot cross gate).

### 8a. Nothing either core keeps carries a credential

ADR 0002 stands: ace reads no CLI configuration, keychain or token file and stores no token. But
the daemon's own environment can hold one (`GH_TOKEN`, `GITLAB_TOKEN`, a CI token the person
exported), the CLIs pass the environment on, and a CLI can echo a credential back (an error that
quotes a URL with `user:token@`, a body that includes an auth header). So:

1. **The supervisor's records are metadata.** The inventory and escapee journals keep pid, start
   identity, uid, group, owner, an executable name and the working directory, as
   `process-inventory.ts:15`–`:24` does today, and nothing else: never argv, never an
   environment value, never stdin. The name is the executable's basename (`gh`, `git`), never a
   request path. Diagnostics name the command and the outcome, never its arguments.
2. **Redaction is value-based as well as pattern-based, and has one owner.** `@ace/redaction`
   already masks exact environment values and their JSON-escaped spellings
   (`createEnvironmentMatcher`, `packages/redaction/src/environment.ts:19`, used by git's failure
   text, `packages/git/src/failure-text.ts:7`). Forge's `redact.ts` duplicates a pattern subset
   (`redact.ts:2`–`:6`, `:20`–`:22`) and misses a credential echoed as a bare value. The fix lands
   in TypeScript first, with its own test: forge redacts through `@ace/redaction` with the child's
   environment as the matcher's values, and its host patterns (`gh*_`, `github_pat_`, `Bearer`,
   key names) move into `@ace/redaction`'s patterns, adding GitLab's `glpat-`/`gloas-`/`glrt-` and
   URL user-info. The values exist only in the matcher, for the request's lifetime: never written,
   logged or put in an error; the daemon already holds them in its environment, so nothing is
   collected (ADR 0002).
3. **Redaction runs over the whole capture, before any clipping.** A clipped tail can cut a secret
   so that neither half matches. Git's failure text clips, then redacts
   (`packages/git/src/failure-text.ts:28`: `redact(...slice(-4000))`), and forge's runner decodes
   each stderr chunk separately into a 4,096-character head (`packages/forge/src/command.ts:138`–
   `:140`). Both become: keep a bounded byte window, decode it once, drop a partial first (or last)
   line at the window's cut, redact the whole window with the request's environment values, and
   only then clip to the reported size. It lands in TypeScript first with a test (a secret straddling
   the cut), then the cores port it. Forge's stderr stays private (`command.ts:36`); only `tea`'s
   narrow header projection leaves the runner, after redaction.
4. **Redaction comes first.** Every reply, stderr tail and diagnostic is redacted before it is
   cached (`GhApi`'s ETag and GraphQL caches, list caches), kept as `raw`, written to a log, put
   in an error's `details`, or serialized for JavaScript. The Rust cores redact through
   **`ace-redaction`**, a port of `@ace/redaction` (F0 owns it; its 11 test files move with it),
   shared by `ace-git` and `ace-forge`.

### 9. Crates

In the `native/daemon` workspace: `ace-git`, `ace-forge`, binding modules `ace-daemon-node/src/git/`
and `ace-daemon-node/src/forge/`.

- **`ace-supervisor`** (ADR 0223) for every process; **`ace-json`** for every JS-visible value and
  host body; **`ace-store`** for the forge's tables; **`ace-protocol`** for protocol shapes.
- **`gix`** 0.91 for G1 and G7 only, `default-features = false`, features `revision`, `status`,
  `sha1`, `sha256` (and `parallel`, `dirwalk`, `excludes`, `attributes` for G7). G6 needs no `gix`:
  **`gix-hash`** and **`gix-object`** (blob ids) and **`cap-std`** (root-relative reads that can't
  escape the root). `uluru` (MPL-2.0) arrives with `gix`'s `pack-cache-lru-static`; because Cargo
  unifies features across the workspace, `deny.toml` bans `uluru` by name and `cargo deny check`
  runs on the resolved workspace graph in `check:daemon-native`.
- **`sha2`** (RustCrypto) for the GraphQL cache key; **`regex`** for the network-failure pattern
  and admission paths (the TypeScript patterns are re-expressed, each checked by its (a) tests);
  **`thiserror`**.
- Rejected: `git2`/libgit2 (C, its own semantics), `octocrab`/`reqwest` for hosts (they need a
  token in the daemon, ADR 0002), `serde_json` for host bodies (not `JSON.parse`).

### 10. Phases, each shippable alone, each switch off by default

| Phase | What moves                                                                                                                                             | Switch                                        | Needs                          | Proven by (class (a) files unless noted)                                                                                   | Ships when                                                                                                      |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| G0/F0 | Crates, bindings, switches, the JS port bridge, digest and verify logs, `deny.toml` ban; no behaviour                                                  | none                                          | ADR 0223 E0                    | `check:daemon-native`, `cargo deny check`                                                                                  | always                                                                                                          |
| G1    | Ref, branch and worktree-list reads on `gix`, inside today's TypeScript service                                                                        | `ACE_GIT=refs`                                | G0                             | git status, worktree and remote rows (22 files)                                                                            | no slower per call; zero (a) diffs; no unlisted fallback                                                        |
| G2    | The git core: process layer, `serial`, `ReadGate`, leases, quarantine, healing, execution policy, config facts, errors                                 | `ACE_GIT=core`                                | G0, ADR 0223 E2                | git process-boundary, lease and non-executing rows (21 files), with injected ports bridged                                 | zero (a) diffs both ways; Windows VM run of the lease and timeout files                                         |
| G3    | Every read on the core: status, info, summaries, diffs and patches, history, revision lines, conflicts, worktree metadata, publication scans           | `ACE_GIT=core,reads`                          | G2                             | git status, history, diff, conflict and transfer-read rows, and the 39 daemon files using `GitService`                     | zero (a) diffs; the ops bench no slower                                                                         |
| G4    | Writes that make no checkpoint: commits, stage, unstage, merges, stack replays, branches, worktrees, fetch, push, clone, init, transfers, publications | `ACE_GIT=core,reads,writes`                   | G3                             | the worktree, remote, transfer, merge and source-control rows                                                              | zero (a) diffs; digests identical (§7) for every commit, merge and worktree write                               |
| G5    | Checkpoints, live diffs, `workspaceRevision`, restore: the CLI snapshot ported step for step (§5 S1–S13), restore under §5a                            | `ACE_GIT=core,reads,writes,checkpoints`       | G4                             | the snapshot and restore-audit rows (17 files), the non-executing row; §7's digests, cross list both ways                  | digests identical on every file of the list; cross runs pass both ways                                          |
| G6    | `snapshot-hash`: §5 N9–N15                                                                                                                             | `+snapshot-hash`                              | G5                             | as G5, plus `ACE_GIT_VERIFY=strict` over every snapshot (a) file; shadow on this repository and the main checkout's clones | zero verify differences; shadow clean; §10a's bench shows the gain. Never restore's safety capture (§5a rule 1) |
| G7    | `status-gix` for display reads (`changed-files.ts:181`, `:241`, `:256`, `:288`, `:302`, `repositoryInfo`); never for a read that precedes a write      | `+status-gix`                                 | G1, G3, the owner (question 4) | the status rows; `ACE_GIT_VERIFY=strict` compares the decoded status with the CLI's                                        | lower wall, no more CPU, zero verify differences                                                                |
| F1    | Forge transport: runner, `GhApi`, write classification, `MutationDispatch`, admission, pinned identities, redaction, errors, readiness                 | `ACE_FORGE=<host>` (transport for that host)  | F0, ADR 0223 E2                | forge transport and write-certainty rows (20 files)                                                                        | zero (a) diffs both ways; transport bench no slower                                                             |
| F2    | GitHub: `GitHubForge`, inbox, repositories, reviews, status revisions, list caches, media, file contents, stacks                                       | `ACE_FORGE=github`                            | F1                             | the GitHub review and browsing rows (27 files) and the daemon files using `fakeGh`                                         | zero (a) diffs both ways; `bench/status.ts` no slower                                                           |
| F3–F5 | GitLab; Gitea and Forgejo; Bitbucket and Origin                                                                                                        | `ACE_FORGE=gitlab`, `tea`, `bitbucket,origin` | F1                             | each host's row                                                                                                            | zero (a) diffs both ways                                                                                        |
| F6    | The pure helpers in Rust for the forge's own use; the daemon's imports native with the switch                                                          | with F2                                       | F1                             | the 9 pure files against both                                                                                              | zero diffs                                                                                                      |
| F7    | `ForgeStore`, `ForgeIntents`, reply receipts on `ace-store`                                                                                            | `ACE_FORGE_STORE=native`                      | F2, `ACE_STORE=native`         | `review*`, `reply-expiry`, `write-dispatch` and the daemon's PR-link tests; per-boot cross gate                            | rows identical both ways                                                                                        |

G1 and F1 can be built in parallel; G2 and F1 both wait on ADR 0223 E2. The CLI path is never
removed: it is what `snapshot-hash` and `status-gix` fall back to, and what every phase keeps for
held directories until the supervisor spawns by descriptor.

### 10a. The equivalent-work bench

No phase claims a saving from a part of the work. Before G6 (and G7) ships, its builder extends
`packages/git/benchmark-ops.ts` and reports, switch off and on, three runs each, with the load
average:

- **What is timed**: the public calls end to end (`createCheckpoint`, `diff` HEAD → working tree,
  `workspaceRevision`, `restoreCheckpoint`, and for G7 `checkoutSummary` and `sourceControlState`),
  so every Git step, Rust hashing, conversion handed to Git, object writes by Git, revalidation and
  crossing are inside the number; `ACE_GIT_VERIFY` off.
- **What is reported** per call: wall p50 and p90; the daemon process's CPU (which includes Rust's
  threads); the Git children's CPU; peak RSS of the daemon and of its children; Git processes;
  loose objects written; each Git step's time; fallbacks by reason; time queued behind `serial`,
  `ReadGate` and the native semaphore.
- **Where**: this repository's 23,528-file clone and the main checkout's clone, read-only (question
  5); a 100,000-file synthetic repository (`benchmark.ts 100000`); and a variant of each with
  `text=auto` on a fifth of the files and CRLF in some, so the `L` share is measured; plus a
  concurrent run (two roots' checkpoints and a status at once).
- **The claim**: a saving is claimed only if p50 wall and total CPU (daemon plus children) are both
  lower in all three runs on every repository; otherwise the phase ships as no slower, or doesn't
  ship.

### 11. Tests move, they don't multiply

As ADR 0223 §9. The (a) files are the proof and are not edited; each runs alone, switch on and off.
The (b) files' cases move with their modules now that the modules move: git's 11 (the parsers,
conflict markers, config sources, diagnostics, publication scan, read gate, lock sweeps and
timestamps, checkout facts) and forge's 4 (Bitbucket markers, Gitea checks, media parsing,
`bktWrite`) become `#[cfg(test)]` modules beside their Rust; the TypeScript files go with their
modules. New Rust tests only for what nothing covers (the fallback triggers of §5 and §6), each
commit saying which. §7's digests and verify mode are the one comparison, justified there.

## Consequences

- The daemon's Git and host logic ends up in Rust, with the TypeScript implementation kept as the
  switch-off path for a release and the Git CLI kept for good as the executor and the fallback.
- No forge request gets cheaper: the CLI and the network are the cost (measurements). The Rust
  forge adds a JSON crossing per result, which F1 and F2 measure.
- Until G6, snapshots cost what they cost today, in Rust. Restore's safety capture is the last
  thing to use `snapshot-hash`.
- Two copies of the forge's pure helpers exist (Rust for the forge, TypeScript for the browser),
  kept equal by running the same 9 test files against both.
- The digest and verify logs are permanent tools: every future change to a snapshot, commit or
  restore path runs them.
- A panic in either core is caught at the binding and thrown as `git_failed` or `ForgeError("cli")`;
  it never takes the daemon down.

## Decided by the orchestrator, pending the owner (2026-11-23)

- **Port both packages** (the owner, 2026-11-23): forge too, driving the same CLIs; git whole,
  writes included, with the snapshot-safety requirements of the review kept.
- **Question 1, stat cache**: no stat cache in G6; every candidate file is hashed.
- **Question 2, CLI fallback**: yes, permanent, with its share reported.
- **Question 3, host tokens**: one CLI process per host request; ADR 0002 unchanged.
- **Question 4, status on `gix`**: decided after G1 (the old numbering's G2) ships.
- **Question 5, where to measure**: this repository and the main `ace-next` checkout, both as
  read-only local clones.
- **Review (2026-11-23)**: forge staying TypeScript was supported before the owner's decision;
  native snapshots are blocked until restore safety and backend parity are shown, which §5 and §7
  now specify.
- **Re-review of b685c2bd1c (2026-11-23)**: proceed with the CLI-backed ports behind opt-in
  switches; G6 and default-on writes stay blocked. Round 3 adds full input revalidation with a
  restart from S1 (§5 N15), the hard rules for restore's safety capture (§5a), operation
  postconditions and separate completion records (§7), proof of the backend pairs that occurred
  and of native coverage per test (§7), credentials kept out of journals, caches and output
  (§8a), and the end-to-end bench (§10a). G0 and G1 start from the current guides.
- **Round 4 (re-check on 3f1509b9be)**: the restore guard covers every path the reset may touch, by
  raw bytes and stat, and nested restores check the whole hierarchy before any write (§5a); N15
  adds the paths Git added and the global and system attributes; redaction runs before clipping
  (§8a); raw index bytes where preservation is promised and completion values, not keys (§7);
  coverage per operation and edge, and non-vacuous strict verdicts (§7). G5 and G6 stay held.

## Questions for the owner

6. **The browser's pure helpers.** Keep the TypeScript copies for `apps/web`, `ui-core` and
   `fake-daemon` (recommended: they are about 1,300 lines, synchronous, and a WebAssembly module
   would make the web app load it asynchronously), or build `ace-forge`'s pure module to
   WebAssembly as `ace-core-wasm` is?
7. **Shadow cost.** `ACE_GIT_VERIFY=shadow` doubles snapshot work while it runs. Run it for one
   release on the owner's machines before G6 default-on (recommended), or only on the clones?
8. **Raw bytes on restore everywhere?** On POSIX, restoring an unchanged entry under `text=auto`
   or eol attributes can rewrite a file's line endings (§5a rule 6); Windows already restores the
   checkpoint's exact bytes. Restore exact bytes on every platform (recommended: one behaviour,
   no silent rewrite), or keep POSIX as it is?
