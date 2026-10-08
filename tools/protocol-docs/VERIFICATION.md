# Verification

Merged origin/main through `4701bfa`. The artifact build, `bun run docs:protocol`, produced 162 schemas and 175 files, including automation and the public Forge subpath contracts. Generation performs the required validation of synthetic examples before writing the output. This build is separate from verification tests and probes.

The owner's current policy permits static verification only. Tests, mutations, drift/compatibility execution, races, large-input verification and benchmarks need run at merge. No execution or flakiness conclusion is claimed for the regression tests below. CI is disabled and was not run. `bun run fmt`, `bun run lint`, `bun run typecheck` and `bun run check:size` passed. All tracked source files satisfy the 1,500-line limit.

## Review fixes and behavior coverage

- Output access validates a caller-owned boundary before inventory or mutation. The CLI supplies the repository as its boundary. Real-directory regressions reject root and intermediate symlinks, preserve target sentinels and existing reference files, and reject escaping roots or invalid output names before writing.
- Compatibility checks use own-property membership. Converted and loaded snapshot dictionaries have no prototype. Public cases remove optional fields and released exports named `toString`, `constructor` and `hasOwnProperty`; a field named `__proto__` is also covered.
- URL export uses the explicit `ace-whatwg-url` format instead of URI validation. Its validator accepts WHATWG URLs after trimming, including Unicode hosts, opaque schemes and parser-normalized forms. Normalized UTF-16 length checks use `x-ace-url-minLength` and `x-ace-url-maxLength`. Regressions cover whitespace, embedded tabs/newlines, malformed URLs, attached built-in checks and normalized length limits. Unsupported URL options or check ordering fail with the owning schema name.
- Both standalone and attached function-backed string formats fail with the owning schema name. The exact attached email predicate from the review has a regression.
- Documentation tests independently enumerate source union alternatives and require an example accepted by each alternative, as well as validation of every emitted example. Omitting a variant cannot pass merely because another example exists on the page.
- Property tests include rejection witnesses for structural invalidity. The independent numeric arbitrary includes signed integers, doubles, fractions and actual bounds. Source example hints also vary numeric leaves, preserving correlated identifiers while producing different valid values. Explicit cases preserve fractional orchestration costs and positive subnormals, and reject invalid bounds and fractional integer fields. Declared semantic rules remain application requirements; they are not mistaken for JSON Schema structural validation.
- Discovery includes the public root and Forge namespace. Export-manifest validation refuses unknown entry points before generation, drift checking or release snapshot capture; its package manifest is fingerprinted. An unknown-entry-point regression guards future subpaths against silent omission.
- Newly merged automation and Forge refinements have source-owned annotations. Exact record limits, schedule multiples and distinct acceptance criteria also have standard JSON Schema constraints.

These tests are written, not executed. Their behavior and mutation sensitivity need run at merge. Existing cases still cover defaults, handshake versions, invalid examples, additive/breaking/rename compatibility, reference targets and siblings, unknown validation changes, malformed snapshots and explicit deep/oversized snapshot refusals, stale/missing/extra artifact repair, source fingerprints and exact bytes. No wall-clock assertion gates tests.

## Mutation cases

Every case is not executed (tests run at merge). The first fifteen retain all cases listed by the review; later cases cover its blockers and test-quality findings.

| Production mutation                         | Intended behavior test                                    | Status                            |
| ------------------------------------------- | --------------------------------------------------------- | --------------------------------- |
| accept removed fields                       | reports a removed field even when optional                | not executed (tests run at merge) |
| ignore newly required fields                | reports required additions and requiredness changes       | not executed (tests run at merge) |
| accept narrowed types                       | rejects unknown to string and number to integer           | not executed (tests run at merge) |
| accept enum removal                         | rejects enum removal                                      | not executed (tests run at merge) |
| accept tighter bounds                       | rejects higher minima and lower maxima                    | not executed (tests run at merge) |
| accept narrowed union variants              | rejects narrowed or removed alternatives                  | not executed (tests run at merge) |
| resolve current refs against old schemas    | detects changed reference targets                         | not executed (tests run at merge) |
| ignore schema deletion                      | reports schema rename and deletion                        | not executed (tests run at merge) |
| ignore unfamiliar validation changes        | requires review for uniqueItems and semantic-rule changes | not executed (tests run at merge) |
| accept unannotated refinements              | reports unsupported Refinement                            | not executed (tests run at merge) |
| use input mode for output defaults          | distinguishes omitted inputs from populated outputs       | not executed (tests run at merge) |
| ignore handshake version mismatch           | rejects inconsistent hello/welcome versions               | not executed (tests run at merge) |
| skip invalid-example validation             | refuses an impossible source refinement                   | not executed (tests run at merge) |
| ignore source fingerprint mismatch          | rejects changed input fingerprints                        | not executed (tests run at merge) |
| ignore artifact digest mismatch             | rejects changed bytes, including malformed UTF-8          | not executed (tests run at merge) |
| skip output-root guard                      | rejects root symlinks and preserves target files          | not executed (tests run at merge) |
| trust intermediate output symlinks          | rejects symlinks beneath the supplied boundary            | not executed (tests run at merge) |
| use inherited membership for fields/exports | rejects reserved-name field/export removal                | not executed (tests run at merge) |
| restore URI format for URL inputs           | accepts whitespace, Unicode and WHATWG forms              | not executed (tests run at merge) |
| apply URL lengths to raw input              | applies length limits after wire normalization            | not executed (tests run at merge) |
| allow attached custom predicates            | identifies AttachedFormat as unsupported                  | not executed (tests run at merge) |
| omit a documented union alternative         | requires a validated example for every source alternative | not executed (tests run at merge) |
| relax an exported structural schema to {}   | rejects source-invalid primitive/container witnesses      | not executed (tests run at merge) |
| export fractional costs as integers         | accepts explicit 0.125 cost values                        | not executed (tests run at merge) |

## Performance

No benchmark ran during these review fixes. The non-gating `bench/generation.ts` measures native conversion, rendering, file comparison, fast drift throughput and peak RSS. Current numbers and the cold under-two-second drift target need run at merge.

Historical measurements recorded before the owner's policy changed, at `e037844` with 132 schemas: 4.79 fast checks/s, 208.68 ms/check, 1665.20 ms/full generation and verification, and 256.06 MiB peak RSS. A separate cold drift check took 1.63 seconds. These numbers predate the review fixes and expanded catalog and do not verify the current revision.

Static review confirms no daemon hot path is added. File comparisons have at most eight concurrent operations and bounded reads. Schema/snapshot counts, recursion and example attempts have caps. Output-root inspection touches only components beneath the supplied boundary. Generation is deterministic and checks examples; the fast drift command uses source and artifact hashes without recompiling example validators.

## Limits and release decisions

Standard JSON Schema cannot fully express sibling-cursor equality, UTF-8 byte bounds or runtime time-zone validity. Source metadata declares these rules as `x-ace-constraint`. URL consumers must install `jsonValidator(snapshot)` from the public package API or implement the documented format and length extensions. Equivalent applications must enforce all declared semantic rules in addition to structural validation.

No released snapshot exists yet. Release tooling must capture and retain the actual released snapshot outside the generated directory. Dynamic MCP toolkits depend on host adapters; this reference documents the shared built-in catalog. Source metadata additions do not change protocol version or parsing behavior. After the main merge, this PR has no daemon-file diff.
