# Workspace verification

## Current verifier round: static review only

The owner now prohibits executing tests, checks that include tests, probes, benchmarks and mutations. No such execution was performed in this round. `bun run typecheck`, `bun run lint`, `bun run fmt` and `bun run check:size` passed. Runtime behavior, the complete repository check and performance of the current head **need run at merge**. CI remains disabled and was not run or awaited.

Main was merged without rebasing, including PR #45's process-test reliability changes. The reported core/daemon/provider test files now match main. No new runtime flakiness comparison was attempted; the verifier's existing same-head control passed with a longer scheduling watchdog, but that does not prove current main or this merged head passes under the same load. That proof needs run at merge.

No PR comment titled "Integration rehearsal: findings for this PR" was present when issue comments, review bodies and inline comments were read. Static cross-PR inspection found the relay Docker dependency stage would invoke the workspace native-build hook. Relay installation now skips lifecycle scripts; it uses no workspace native code. An opt-in Docker behavior test builds the actual image and uses the existing encrypted host/client round-trip harness. It is not executed now.

New and revised public behavior tests were written before their fixes, using the verifier's executed reproductions as prior evidence. They were not executed before or after editing:

- `terminal-lines.test.ts` expects independent byte columns for `a*` and `$` at ASCII/Unicode EOF, LF/CR, a complete-character budget cut and an incomplete UTF-8 budget cut. It checks physical byte accounting, truncation and empty-file behavior in both real backends.
- `directory-limits.test.ts` retains the 10,001-file scan rejection and page-cap assertions through `createWorkspace`. Setup is outside the assertion body, creates the directory once, and drains every issued write before cancellation/cleanup. Workspace suites join the shared process project, whose scheduling allowance applies to setup, tests and teardown.
- `apps/relay/src/docker.test.ts`, enabled by `ACE_RELAY_DOCKER_TEST=1` at merge, verifies production image installation and encrypted protocol traffic. Default runs skip this Docker prerequisite.

The common search input adds at most one LF to a nonempty unterminated decoded line. It retains one character of state, does no growing-prefix or per-match work, and leaves physical byte budgets unchanged. Existing benchmark measurements below are historical; no new performance execution occurred.

### Mutation cases designed for these tests

Every case here is **not executed (tests run at merge)**.

| Production mutation                                      | Intended observable failure                                                                   |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Remove terminal LF normalization                         | rg omits EOF `$` and terminal `a*` matches                                                    |
| Normalize only physical EOF, not budget-cut prefixes     | ASCII/Unicode cut-prefix terminal matches disappear                                           |
| Count the synthetic LF as scanned input                  | Physical byte-accounting assertions fail                                                      |
| Always add a newline, including empty files              | Empty files acquire an unexpected `$` occurrence                                              |
| Always add another newline after LF/CR                   | An extra empty-line match appears                                                             |
| Return UTF-16 columns                                    | Unicode end column is wrong                                                                   |
| Decode incomplete UTF-8 without replacement              | The cut-prefix preview/columns differ from independent expectations                           |
| Raise the directory cap to admit 10,001 entries          | Oversized scan returns results instead of LIMIT_EXCEEDED                                      |
| Permit page size 1,001                                   | Invalid page request succeeds                                                                 |
| Re-enable root lifecycle scripts in relay Docker install | Image installation depends on unavailable workspace compiler/runtime before encrypted traffic |

The directory setup/cleanup ordering was reviewed statically. Timeout and cleanup-race execution needs run at merge; no structural assertions or injected timeout probe were added.

## Historical fix-round execution at 7c24bbf

The suite uses the package public API with real temporary directories, Git repositories, installed ripgrep, native notifications and child processes. Tests synchronize through operations, worker/process events, change batches and an injected logical clock. No sleep or throughput threshold gates these tests. Provider CLIs and the recorder are never invoked.

`origin/main` was merged without rebasing before the review changes. At `7c24bbf`, the local gate ran formatting, lint, the 1,500-line size limit, every package typecheck and Vitest. It passed with 456 tests, including 58 workspace tests; four existing opt-in live provider probes remain skipped. The workspace suite also passed on Node 24.21.0. CI is disabled by the owner and was neither requested nor awaited.

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

Each production mutation was applied independently. A targeted public behavior test exited 1 with a behavioral assertion failure, then the original source was restored in a `finally` block. Syntax, import failures and watchdog timeouts do not count. Native bridge mutations were compiled before testing and compiled again after restoration. All 24 were checked against `7c24bbf`, before the current verifier round. They were not rerun now.

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
