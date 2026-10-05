# Provider transcript noise: PR #128 review follow-up

The owner forbids test, probe, mutation, benchmark, full-check and CI execution
before merge. This follow-up uses static review and the permitted static checks.
Every behavioral or performance result below needs run at merge. The earlier
PR description's test results belong to `40e3b4d9`, not this follow-up.

## Reproduction and fixes

Before changing ACP production code, `child-diagnostics.test.ts` was written
against `createAcpTranslator` through `replayFixture` and its core projection.
The pre-fix `childUpdate` passed explicit text `ACP child association` to
`TranslationState.notice`, which emits an `item.upsert` notice. Each running or
terminal snapshot therefore violates the new test's empty-notice assertion.
This is a static reproduction; no failing or passing run is claimed.

The fix removes that explicit text. Association facts and source receipts stay
intact, and the separate `Child disconnected; completion is unconfirmed` notice
remains. The tests check live-child precedence after parent completion, final
settlement, parent/child linkage, raw receipts, and the disconnected warning
for generic ACP, Cursor ACP and Antigravity ACP. The shared cross-adapter corpus
also contains repeated running and completed child snapshots.

The shared undrained-diagnostic test now gives each receipt its own marker. It
requires `receipt-255`, rejects `receipt-0`, requires one pending diagnostic,
and requires an empty second drain. Keeping the first receipt can no longer
satisfy it.

OpenCode's translator retains diagnostic receipts by reference, matching
Codex/Cursor. It no longer sanitizes every native receipt before translation.
The daemon's existing diagnostic callback calls bounded `logMetadata` before
logging, and the file sink redacts before durable writes. Canonical item and
error evidence still pass through OpenCode's `raw` sanitizer. The top-level
decode is shared with the translation branch rather than performed twice.
Cumulative snapshot tests require full diagnostic envelopes, sanitized
canonical evidence and successful transcript projection.

The daemon test name now describes size-limited records rather than implying
that one oversized-value assertion measures sustained file retention. A
separate public logger/file-sink test writes sustained provider diagnostics and
asserts per-file and total byte caps, recent evidence retention, old evidence
removal, secret redaction and oversized-value omission.

## Mutation cases

All cases are **not executed (tests run at merge)**. These mappings describe
the assertions designed to reject the mutations; they do not claim observed
mutation kills. The review reported no executed surviving mutations. Case 5
was its identified assertion gap.

Test keys:

- C: shared corpus in `apps/daemon/src/engine/protocol-noise.test.ts`.
- B: distinct-receipt burst/drain test in the same file.
- V: unknown projected content and malformed-frame test in OpenCode `v2.test.ts`.
- P: readable notifications and failed-command test in Pi `translator.test.ts`.
- S: raw-byte scaling test in Pi `translation-scaling.test.ts`.
- A: ace-input echo test in ACP `session.process.test.ts`.
- D: new ACP `child-diagnostics.test.ts`.
- R: sustained provider file-retention test in `provider-diagnostics.process.test.ts`.

| Case | Mutation                                           | Intended assertion                             |
| ---- | -------------------------------------------------- | ---------------------------------------------- |
| 1    | ACP default emits `ACP frame`                      | C: zero routine notices                        |
| 2    | ACP default discards raw                           | C: exact source evidence survives later output |
| 3    | ACP accumulates undrained diagnostics              | B: exactly one pending receipt                 |
| 4    | ACP drain leaves pending evidence                  | B: second drain empty                          |
| 5    | ACP keeps first undrained evidence                 | B: final marker present and first absent       |
| 6    | ACP ace-input echo becomes visible                 | A: no echo delta or notice; raw retained       |
| 7    | OpenCode unknown SSE becomes label notice          | C: zero routine notices                        |
| 8    | OpenCode discards frame diagnostics                | C: exact source evidence survives              |
| 9    | OpenCode accumulates pending diagnostics           | B: exactly one pending receipt                 |
| 10   | OpenCode drain does not clear                      | B: second drain empty                          |
| 11   | Unknown projected content becomes notice           | V: zero opaque-content notices                 |
| 12   | Malformed OpenCode frame silently returns empty    | V: readable error; completion uncertain        |
| 13   | Cursor unknown delta becomes notice                | C: zero routine notices                        |
| 14   | Cursor unknown stream message becomes notice       | C: zero routine notices                        |
| 15   | Cursor unknown envelope becomes notice             | C: zero routine notices                        |
| 16   | Pi unknown event becomes notice                    | C: zero routine notices                        |
| 17   | Pi opaque final message becomes notice             | C: zero routine notices                        |
| 18   | Pi setStatus becomes notice                        | C: zero routine notices                        |
| 19   | Pi suppresses notify                               | P: warning notification present                |
| 20   | Pi suppresses failed response                      | P: failed-command error present                |
| 21   | factRaw misses message evidence                    | S: no duplicated Pi diagnostic envelope        |
| 22   | Restore ACP child association notice               | C/D: repeated snapshots produce no notices     |
| 23   | Suppress disconnected-child warning                | D: warning present; completion unconfirmed     |
| 24   | Discard child association raw                      | D: every child receipt retained                |
| 25   | Bypass canonical OpenCode error sanitization       | V: secret redacted in error evidence           |
| 26   | Disable log rotation or total retention            | R: per-file and total byte caps                |
| 27   | Bypass diagnostic redaction/oversize normalization | R and daemon corpus: secret/large value absent |

## Performance verification

Static work accounting: the removed receipt sanitizer previously walked and
copied the entire native frame, and projected canonical messages then used
their existing sanitizer. Diagnostic retention now allocates one array and one
wrapper referencing the receipt. It does no recursive walk or copy. The
existing canonical sanitizer is unchanged. No diagnostic-history scan is added.
This is code analysis, not a throughput or allocation measurement.

The new driver is `packages/adapter-opencode/bench/diagnostics.ts`. It measures
unknown SSE traffic and growing user-message snapshots at 4,096, 65,536 and
262,144 text bytes. It drains after each translation, reports fact/diagnostic
counts, and reports median throughput, sampled peak heap and post-GC retained
heap from five runs after warmup. Frame construction occurs outside measurement.
Peak heap is sampled every 16 frames; it is allocation-pressure evidence, not
an exact total allocation count.

At merge, run the same driver on `40e3b4d9` and the follow-up head under the same
Node version and machine load. For the baseline, copy the new driver into the
baseline checkout without changing its translator. Invoke from each checkout:

```sh
node --expose-gc packages/adapter-opencode/bench/diagnostics.ts
```

| Workload                                              | Baseline frames/s and heap MiB | Follow-up frames/s and heap MiB |
| ----------------------------------------------------- | ------------------------------ | ------------------------------- |
| Unknown SSE, each of the three payload sizes          | needs run at merge             | needs run at merge              |
| Cumulative snapshots, each of the three payload sizes | needs run at merge             | needs run at merge              |

No benchmark numbers are fabricated or extrapolated. No claim that the
performance bar passes is made until measurements are available.

## Merge-time gates

- Follow-up static checks passed: targeted `bun run fmt`, `bun run lint`,
  `bun run typecheck`, `bun run check:size`, `bun run check:deps`, and
  `bun run docs:protocol --check`. The size check covered 3,594 source files.
  Dependency-cruiser exited successfully but reported limited TypeScript 7
  support, so its dependency coverage remains limited.
- Run the behavior tests and mutation cases once at merge.
- Run the comparison benchmark at merge and record its measurements.
- Run `bun run check` at merge; it is forbidden in this follow-up because it runs tests.
- CI is disabled. Do not run, re-run or watch it.
- No UI changes are needed for this backend correction.
