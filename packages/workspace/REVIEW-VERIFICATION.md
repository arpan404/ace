# Workspace verification

The suite uses the package public API with real temporary directories, Git repositories, installed ripgrep, native notifications and child processes. Tests synchronize through operations, worker/process events, change batches and an injected logical clock. No sleep or throughput threshold gates these tests. Provider CLIs and the recorder are never invoked.

`origin/main` was merged without rebasing before the review changes. The final local gate runs formatting, lint, the 1,500-line size limit, every package typecheck and Vitest. It passes with 456 tests, including 58 workspace tests; four existing opt-in live provider probes remain skipped. The workspace suite also passes on Node 24.21.0. CI is disabled by the owner and was neither requested nor awaited.

Earlier Node 26 repository runs hit watchdogs in unchanged core, daemon and provider-kit tests under machine load. The complete gate was rerun on Node 24 as `bun run check --maxWorkers=2 --testTimeout=60000 --hookTimeout=60000`. These are hang watchdogs, not performance assertions.

## Review regressions

Each blocking issue was reproduced with a failing public behavior before its fix:

- A coordinated ABA parent swap exposed `OUTSIDE SECRET`. Descriptor-relative traversal now prevents escape; tests also cover root-ancestor swaps and a successful stable read afterward.
- Unsupported control, NUL and surrogate escapes differed between engines; emoji empty matches appeared at interior UTF-8 bytes. Independent expected results now require typed rejection and columns 1 and 5.
- A dense one-MiB line with limit 1 failed with `LIMIT_EXCEEDED`. Incremental submatch parsing now returns one match successfully.
- Native index changes failed to announce tracked/ignored visibility transitions. Both `git add -f` and `git rm --cached` now emit batches without `flush()`, including linked worktrees.
- A text file larger than the read cap disappeared from search. Both backends now find occurrences before and beyond 1 MiB and obey a smaller total budget.

Additional behavior tests cover descriptor inode replacement, transient `EINVAL`, native mode, the full logical 100 ms debounce, matching-start acknowledgements before cancellation, process/worker exit before rejection, malformed worker IPC, regex class differences and real FIFO transport for batched ripgrep input.

## Mutations

Each production mutation was applied independently. A targeted public behavior test exited 1 with a behavioral assertion failure, then the original source was restored in a `finally` block. Syntax, import failures and watchdog timeouts do not count. Native bridge mutations were compiled before testing and compiled again after restoration. All 24 were checked against the final implementation.

| Production mutation                 | Behavior that failed                                    |
| ----------------------------------- | ------------------------------------------------------- |
| traversal                           | Traversal rejects .. segments                           |
| containment                         | Outside symlink paths are rejected                      |
| binary detection                    | Binary reads return metadata only                       |
| read cap                            | Large reads stop at 1 MiB                               |
| ignore suppression                  | Ignored files stay hidden                               |
| listing depth                       | Depth-limited listing returns expected entries          |
| pagination                          | Pagination has no gaps                                  |
| case sensitivity                    | Case-insensitive occurrences are returned               |
| byte budget                         | Both backends obey the byte budget                      |
| match limit                         | Both backends stop at the global match limit            |
| cancellation                        | Cancelled searches reject ABORTED                       |
| watch change kind                   | Writes coalesce as changed                              |
| descriptor inode comparison         | Replacement file identity is rejected                   |
| zero debounce                       | Native writes remain pending until logical 100 ms       |
| reject all reads                    | Stable reads succeed after the race                     |
| unchecked pathname opening          | Coordinated ABA swaps never expose outside bytes        |
| unsupported escapes accepted        | Unsupported escapes reject INVALID_ARGUMENT             |
| Unicode interior matches            | Empty matches occur only at Unicode boundaries          |
| buffer complete rg event            | Dense one-MiB lines return one successful limited match |
| omit git index invalidation         | Index removal emits deletion without refresh            |
| restore per-file search cap         | Matches beyond 1 MiB remain searchable                  |
| accept zero worker limit            | Malformed worker messages reject SEARCH_FAILED          |
| root ancestor following             | Root ancestor insertion cannot expose outside bytes     |
| omit linked-worktree metadata watch | Linked-worktree index changes emit visibility batches   |

The three survivors from review are now killed: removing descriptor inode comparison, setting debounce to zero and rejecting every read. The dense-event mutation restores both whole-event buffering and the fixed 4 MiB output cap, reproducing the reviewed failure.

Commands used `bun run test packages/workspace/src/<file>.test.ts -t '<behavior>' --testTimeout=30000`. Throwaway runner scripts and logs are not committed. Benchmark datasets, commands and paired measurements are recorded in the package README; timings are observations only.
