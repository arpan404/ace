# Workspace verification

The public API suite uses real temporary directories, Git repositories, installed ripgrep, native `fs.watch` notifications, and a child process continuously swapping a directory with an outside symlink. Tests await operations, IPC and change batches; no sleep or performance threshold gates the suite. Provider CLIs and the recorder are never invoked.

`bun run check` passed after rebasing onto main and restoring all mutations: 390 tests, including 33 workspace tests. Four pre-existing opt-in live provider probes remain skipped. The workspace suite also exercises forced polling, regex/BOM/newline parity, limits, worker startup, cancellation and disposal. The package README records a non-gating 1,000-file benchmark.

## Mutations

Each mutation below was applied individually to production code. Its targeted Vitest run exited 1 with the named public behavior failing, then the original source was restored in a `finally` block. All twelve were rerun successfully against the final implementation after integration with main.

| Mutation                                       | Behavior that failed                                                                |
| ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| Remove the `..` segment guard                  | Traversal and absolute paths are rejected even when normalization stays inside      |
| Disable realpath containment checks            | Outside file and directory symlinks are rejected                                    |
| Detect byte 255 instead of NUL                 | First-8-KiB binary content returns metadata without text at a later offset          |
| Raise the read cap to 2 MiB                    | Large reads stop at 1 MiB                                                           |
| Stop filtering ignored entries                 | Nested ignore rules, negations and newline filenames hide the right files           |
| Traverse at depth 1                            | Listing obeys depth and returns the expected relative metadata                      |
| Advance page cursors one extra entry           | Paging returns every expected path without gaps or duplicates                       |
| Always use case-sensitive matching             | Case-insensitive search includes the uppercase `NEEDLE` line                        |
| Double the caller's byte budget                | Both backends stay within four bytes and omit the second matching file              |
| Continue after reaching the global match limit | Both backends return exactly two occurrences across multiple matching files         |
| Discard the caller's AbortSignal               | Pre-cancelled and in-progress searches reject with `ABORTED`                        |
| Emit `created` for modifications               | Coalesced writes report `changed`, and ignore-rule transitions reconcile visibility |

Commands used the form `bun run test packages/workspace/src/<file>.test.ts -t '<behavior>'`. Failures were behavioral assertions, not import, syntax or type failures. Throwaway mutations and runner scripts are not part of the branch.
