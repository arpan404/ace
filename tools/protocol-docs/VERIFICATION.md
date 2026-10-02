# Verification

The generator covers 132 schemas and writes 142 artifacts after merging origin/main at `19a7e14`. This includes payload paging, orchestration, model catalogs and the existing remote access and encrypted relay work.

Focused tests cover random Zod-accepted JSON values for every export, all documented union examples, stable references and ids, input/output defaults, declared semantic constraints, unsupported constructs, protocol version negotiation, stale/missing/unexpected files, and additive/breaking/rename compatibility. Reference changes, array constraints, union siblings, description-only edits and malformed snapshots have regression cases. The temporary-directory drift test uses representative generated schema content rather than repeatedly writing the entire catalog.

## Mutation results

Each mutation below changed production logic, produced an assertion failure in the listed behavior, and was reverted before validation. No timeout or compilation error counted as a kill.

| Mutation                            | Failing behavior                           |
| ----------------------------------- | ------------------------------------------ |
| removed fields accepted             | reports a removed field                    |
| new required fields ignored         | reports required additions                 |
| narrowed types accepted             | rejects unknown to string                  |
| enum removals accepted              | rejects enum removal                       |
| new reference target ignored        | detects a changed target                   |
| stale bytes ignored                 | detects missing                            |
| unannotated refinement accepted     | unsupported Refinement                     |
| output defaults exported as input   | distinguishes accepted input defaults      |
| source fingerprint mismatch ignored | fast drift checks reject changed inputs    |
| artifact digest mismatch ignored    | fast drift checks reject changed artifacts |

## Performance

Non-gating `bun run --filter @ace/protocol-docs bench`, ten iterations on the shared machine: full generation and byte checking takes 1665.20 ms/iteration, with 44.49 ms native conversion, 1410.49 ms rendering and source hashing, and 210.21 ms file comparison. Fast drift checks run at 4.79 checks/s, 208.68 ms/check. Peak RSS across both phases is 256.06 MiB. A separate cold `bun run docs:protocol --check` took 1.63 seconds wall time, 0.19 seconds user CPU and 0.07 seconds system CPU.

The fast check still converts every schema and rejects unsupported constructs. Its fingerprint covers converted schemas, tool definitions, production sources and the lockfile. It checks every artifact's byte length and SHA-256, plus missing and unexpected files. Generation validates examples before writing the manifest. File checks use at most eight concurrent operations and bounded reads.

Tests originally exposed expensive construction of fast-check's general URL arbitrary. The independent Zod walker now produces varied synthetic HTTPS URLs directly and caches shared schemas within each traversal. Full catalog writes in the drift regression also exceeded the default timeout under shared-machine load; the regression now exercises the same real file API with two representative files. These changes reduce work without weakening the behaviors checked. No elapsed-time assertion gates tests.

## Limits and decisions

Standard JSON Schema cannot fully express sibling-cursor equality, UTF-8 byte bounds or runtime time-zone validity. Source metadata declares those semantic rules as `x-ace-constraint`. Equivalent applications must enforce them in addition to structural JSON Schema validation. Unannotated refinements fail generation. Record entry caps and reserved identifier exclusions also have native JSON Schema constraints in their source metadata.

No released snapshot exists yet; release tooling must capture and retain one using the snapshot command. Dynamic MCP toolkits are host-specific; this reference documents the built-ins from the shared public catalog rather than advertising absent backends. No protocol version or wire behavior changes were introduced here.
