# Hermetic home review follow-up

PR #103 merges `origin/main` with commits `9e8fb08f` and `830b8b96`, including PR #102's
desktop integration without edits to its files. This follow-up uses static
review only. The owner's newest rule prohibits tests, probes, mutation runs,
benchmarks, `bun run check` and CI execution or waiting. Behaviour tests were
written before the blocking fixes, but their red/green results **need run at merge**.
The earlier 38-test result predates these changes and does not verify this revision.

## Boundaries

The shared guard lives in `@ace/provider-kit/test-isolation`; `@ace/service` retains
its exported home guard. Its pure policy receives path semantics, a working
directory and a realpath port. The Node boundary supplies environment parsing and
filesystem resolution. Both the candidate and the protected root resolve through
their nearest existing ancestors, with missing suffixes preserved. Lexical
descendants are refused before realpath. Missing or unreadable ancestors fail
closed except for ENOENT, which permits walking toward an existing ancestor.

The injected daemon-home resolver now requires an explicit path-check port. The
production resolver supplies the test-only boundary there. Compatibility checks
retain legacy-data validation. An injected resolver regression observes a receipt
that its real filesystem boundary would write, and checks that refusal prevents it.

Worker setup and process fixture builders use the same environment policy. It
discards ambient ACE settings and provider, shell, Git, cache and configuration
path selectors; redirects user, provider, XDG and temporary roots; and supplies
empty history/model instance lists. Worker setup also deletes discarded keys from
the live environment instead of merely overlaying new values. Known destination
guards cover account registries, history homes, model configuration, signing-key
files and terminal environments. Daemon preflight checks run before acquiring a
lock so optional-service degradation cannot hide a restored path override.
Ambient ACE opt-in flags are discarded along with other owner configuration;
hermetic root runs do not launch the owner's live provider/device fixtures.

The root Vitest config applies shared setup to unit, process, web and client-react
projects. It preserves each React project's plugins and hooks and runs isolation
before its own setup. No UI file was edited. Package-only runs using the standalone
UI configs are a follow-up for the Claude web agent; the standard root runner now
isolates all four projects.

Unexpectedly fulfilled daemon attempts register shutdown before the rejection
assertion can fail. Child JSON observations pass through schemas. Added rehearsals
exercise distinct HOME/XDG/temp directories across all four projects and two
concurrent runs, teardown after worker cleanup, and cleanup after a setup failure.
These rehearsals are written tests, not execution evidence.

## Mutation coverage

All rows are **not executed (tests run at merge)**. They describe the observable
assertions designed to reject each mutation, not measured mutation kills.

| Review case | Mutation                                        | Behaviour assertion                                                                |
| ----------- | ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1           | Guard returns unconditionally                   | Protected HOME/data-dir refusals in `test-home.process.test.ts`                    |
| 2           | Remove resolver home guard                      | Direct protected-home resolution and injected receipt test                         |
| 3           | Remove compatibility guard                      | `localService` with protected data and safe ambient HOME                           |
| 4           | Remove daemon ambient home guard                | Owned daemon with safe config and protected HOME                                   |
| 5           | Remove local-service ambient guard              | Local service with safe data and protected HOME                                    |
| 6           | Skip home check when a request is explicit      | Protected HOME with safe ACE_HOME in `test-home.process.test.ts`                   |
| 7           | Skip requested-home compatibility               | Existing explicit legacy-home refusal in `legacy-home.process.test.ts`             |
| 8           | Skip custom daemon data validation              | Owned daemon with protected config; protected-directory preservation               |
| 9           | Reject only the exact protected root            | Library, missing and `..cache` descendants                                         |
| 10          | Exempt the exact protected root                 | Exact-root resolution and explicit-data refusals                                   |
| 11          | Use naive path-prefix rejection                 | `owner-other` sibling remains accepted                                             |
| 12          | Treat any `..` prefix as escape                 | `..cache` descendant refusal, including Windows policy                             |
| 13          | Treat a different drive as contained            | Windows policy accepts `D:` with protected `C:`                                    |
| 14          | Remove the inactive early return                | Unset guard accepts a cyclic alias without filesystem inspection                   |
| 15          | Swallow refusal and continue                    | Resolver refusals, legacy-byte preservation and no boundary receipt                |
| Added       | Skip canonicalizing the candidate               | Alias, missing-descendant and legacy-marker refusals                               |
| Added       | Skip canonicalizing the protected root          | Protected-root alias and missing protected-root tests                              |
| Added       | Drop absent suffixes                            | Missing protected-root sibling remains accepted while its descendant is refused    |
| Added       | Retain inherited application/provider selectors | Sanitized child writes its private accounts DB; protected fixture stays empty      |
| Added       | Only overlay worker variables                   | Four-project rehearsal's setup fails if ACE_ACCOUNTS_DB survives                   |
| Added       | Remove account destination guard                | Restored DB override refuses account CLI access; bytes and permissions stay intact |
| Added       | Remove history destination guard                | Explicit/default provider homes and custom daemon history are refused              |
| Added       | Retain inherited ZDOTDIR                        | Private startup receipt appears; protected startup receipt stays absent            |
| Added       | Remove terminal destination guard               | Restored ZDOTDIR is refused before shell launch                                    |
| Added       | Remove model destination guards                 | Restored cwd, home and provider selectors are refused before discovery             |
| Added       | Remove a project's shared setup                 | That project's module-evaluation/home observation fails                            |
| Added       | Reuse homes across files/runs                   | Concurrent observations collide or one runner removes another's home               |
| Added       | Omit global teardown                            | Recorded homes remain on disk after child runner exit                              |

## Performance

This change adds no work to delta translation, event fan-out or history iteration.
The inactive boundary still has a function call and an environment lookup; it does
zero schema parsing, path resolution or filesystem operations. This is not a
literal zero-instruction claim. A direct lexical refusal also performs zero
filesystem operations. An active check with existing endpoints performs two
realpath calls. Missing endpoints walk up the path depth; no resolved-home cache
can go stale after a symlink changes. Homes and fixture bytes remain owned until
global teardown, so their lifetime storage grows with the number of test files.

The unexecuted harness `packages/provider-kit/src/test-isolation.bench.ts` records
baseline, inactive, existing-path, 16-missing-component and alias-rejection timings,
with 100 warmup iterations and 10,000 measured iterations by default. It uses only
synthetic temporary homes. Wall-clock milliseconds and ns/operation are **needs run
at merge**. No performance measurements or mutation kill rates are claimed here.

## Validation

`bun run fmt`, `bun run lint`, `bun run typecheck`, `bun run check:size`,
`bun run check:deps` and `bun run docs:protocol --check` passed. All 3,459 tracked
source files satisfy the 1,500-line limit. Root typecheck includes the new
setup/config and rehearsal sources. Dependency-cruiser reports its existing
TypeScript 7 support warning; its dependency check exits successfully.
Only the generated protocol manifest input checksum changed after the lockfile
update; the reference content is unchanged.

`bun run check`, test execution, benchmarks, mutation runs and flakiness checks
remain **needs run at merge**. CI is disabled by the owner and was neither run nor
waited on. The real `.ace` and `.ace-next` directories are not fixture locations.
No comment titled "Integration rehearsal: findings for this PR" was present when
PR comments were checked during this follow-up.
