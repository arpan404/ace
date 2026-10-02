# Verification

The committed reference contains 132 schemas and 142 artifacts after merging origin/main at `19a7e14`. This includes payload paging, orchestration, model catalogs and the existing remote access and encrypted relay work.

The repo owner’s updated policy permits static checks only during this workstream. Tests, mutations, generator execution, drift execution, compatibility execution and benchmarks need run at merge. Earlier execution observations are not used as the final verification gate. The interrupted test runner has been stopped. `bun run fmt`, `bun run lint`, `bun run typecheck` and `bun run check:size` passed.

## Behavior coverage awaiting execution

The property tests generate random Zod-accepted JSON values for every export and validate them against independent Ajv validators. Other cases cover documented union examples, stable references and ids, input/output defaults, declared semantic constraints, unsupported constructs and protocol version negotiation.

Compatibility cases cover additive changes, removed fields and schemas, newly required fields, narrowed types and enums, renames, changed reference targets, array constraints, union siblings, description-only edits and malformed snapshots. Real temporary-directory cases cover stale, missing and unexpected files and repair through regeneration. Fingerprint cases cover source changes, semantic changes, tool definitions and exact artifact bytes, including malformed UTF-8.

All behavior claims above need run at merge. No wall-clock assertions gate these tests.

## Planned mutations

These cases identify the production changes the behavior tests are designed to reject. The current required mutation verification is not executed (tests run at merge).

| Mutation                               | Behavior designed to reject it             | Status                            |
| -------------------------------------- | ------------------------------------------ | --------------------------------- |
| removed fields accepted                | reports a removed field                    | not executed (tests run at merge) |
| new required fields ignored            | reports required additions                 | not executed (tests run at merge) |
| narrowed types accepted                | rejects unknown to string                  | not executed (tests run at merge) |
| enum removals accepted                 | rejects enum removal                       | not executed (tests run at merge) |
| new reference target ignored           | detects a changed target                   | not executed (tests run at merge) |
| missing/stale file comparison bypassed | detects missing and stale files            | not executed (tests run at merge) |
| unannotated refinement accepted        | reports unsupported Refinement             | not executed (tests run at merge) |
| output defaults exported as input      | distinguishes accepted input defaults      | not executed (tests run at merge) |
| source fingerprint mismatch ignored    | fast drift checks reject changed inputs    | not executed (tests run at merge) |
| artifact digest mismatch ignored       | fast drift checks reject changed artifacts | not executed (tests run at merge) |

## Performance verification awaiting execution

The non-gating benchmark in `bench/generation.ts` measures native conversion, full rendering, file comparison, fast drift checks and peak RSS. Throughput, memory measurements and the cold drift check’s under-two-second target need run at merge; no benchmark is executed under the current policy.

Static review confirms the fast check converts schemas and applies construct guards, fingerprints converted schemas/tool definitions/production sources/the lockfile, and checks artifact byte lengths and SHA-256 digests. Generation validates examples before writing the manifest. File comparisons have at most eight concurrent operations and bounded reads. No daemon hot path is added.

## Limits and decisions

Standard JSON Schema cannot fully express sibling-cursor equality, UTF-8 byte bounds or runtime time-zone validity. Source metadata declares those semantic rules as `x-ace-constraint`. Equivalent applications must enforce them in addition to structural JSON Schema validation. Unannotated refinements fail generation. Record entry caps and reserved identifier exclusions also have native JSON Schema constraints in their source metadata.

No released snapshot exists yet; release tooling must capture and retain one using the snapshot command. Dynamic MCP toolkits are host-specific; this reference documents the built-ins from the shared public catalog. No protocol version or wire behavior changes were introduced here.

The only daemon-file change removes the foreground CLI test’s fixed 15-second override so it honors the configured runner timeout. Its assertions remain intact. Execution of this integration case and the full repository gate needs run at merge. CI is disabled and was not run.
