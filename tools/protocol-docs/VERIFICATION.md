# Verification

The generator covers 132 schemas and writes 141 artifacts after merging origin/main at `19a7e14`. This includes payload paging, orchestration, model catalogs and the existing remote access and encrypted relay work.

Focused tests cover random Zod-accepted JSON values for every export, all documented union examples, stable references and ids, input/output defaults, declared semantic constraints, unsupported constructs, protocol version negotiation, stale/missing/unexpected files, and additive/breaking/rename compatibility. Reference changes, array constraints, union siblings, description-only edits and malformed snapshots have regression cases. The temporary-directory drift test uses representative generated schema content rather than repeatedly writing the entire catalog.

## Mutation results

Each mutation below changed production logic, produced an assertion failure in the listed behavior, and was reverted before validation. No timeout or compilation error counted as a kill.

| Mutation                          | Failing behavior                      |
| --------------------------------- | ------------------------------------- |
| removed fields accepted           | reports a removed field               |
| new required fields ignored       | reports required additions            |
| narrowed types accepted           | rejects unknown to string             |
| enum removals accepted            | rejects enum removal                  |
| new reference target ignored      | detects a changed target              |
| stale bytes ignored               | detects missing                       |
| unannotated refinement accepted   | unsupported Refinement                |
| output defaults exported as input | distinguishes accepted input defaults |

## Performance

Non-gating `bun run --filter @ace/protocol-docs bench`, ten generation-and-check iterations on the shared machine: 0.52 checks/s, 1940.60 ms/check, 78.42 ms conversion, 1499.81 ms rendering, 362.36 ms file comparison, 245.36 MiB peak RSS. Native conversion runs once per mode. Ajv reuses compiled references and owning-schema validators. File checks use at most eight concurrent operations and bounded reads.

Tests originally exposed expensive construction of fast-check's general URL arbitrary. The independent Zod walker now produces varied synthetic HTTPS URLs directly and caches shared schemas within each traversal. Full catalog writes in the drift regression also exceeded the default timeout under shared-machine load; the regression now exercises the same real file API with two representative files. These changes reduce work without weakening the behaviors checked. No elapsed-time assertion gates tests.

The benchmark ran while other workers were active. An individual cold check took 3.91 seconds wall time with 0.52 seconds user CPU and 0.07 seconds system CPU; scheduling and I/O on this machine vary considerably. The mean complete check stays below two seconds; this is not a timing gate.

## Limits and decisions

Standard JSON Schema cannot fully express sibling-cursor equality, UTF-8 byte bounds or runtime time-zone validity. Source metadata declares those semantic rules as `x-ace-constraint`. Equivalent applications must enforce them in addition to structural JSON Schema validation. Unannotated refinements fail generation. Record entry caps and reserved identifier exclusions also have native JSON Schema constraints in their source metadata.

No released snapshot exists yet; release tooling must capture and retain one using the snapshot command. Dynamic MCP toolkits are host-specific; this reference documents the built-ins from the shared public catalog rather than advertising absent backends. No protocol version or wire behavior changes were introduced here.
