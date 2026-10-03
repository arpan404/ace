# Accounts verifier follow-up

The repository owner requires static verification only. No tests, probes, benchmarks,
flakiness runs, mutation runs or CI jobs were started in this follow-up. Every runtime
claim below **needs run at merge**. Earlier executed results in PR #25 are historical.

## Behavior guards written

Tests exercise public APIs. They use temporary SQLite/files and harmless boundary
processes when run at merge, with promise barriers rather than synchronization sleeps.

- `untrusted-ingress.test.ts`: a map whose enumeration/read traps throw must be rejected
  without either trap running, must leave quota unavailable, and must return raw unchanged.
  This uses the same `ingestQuota` API as the verifier's unbounded-map reproduction.
- `ingress.test.ts`: reject oversized encoded strings, multibyte strings and byte arrays
  before JSON admission. Preserve admitted unknown data by identity; reject attempts to
  mutate the root or nested data after certification.
- `ingress.test.ts`: uncertified and mismatched adapter data never reach engine callbacks
  or SQLite quota state; shutdown completes and an explicit failure is reported.
- `review-quota.test.ts`: updating existing `w0` while overflow is active keeps exhaustion;
  a subsequent complete bounded authoritative snapshot restores availability.
- `service-review.test.ts`: after a real child's natural exit, lifetime-bound resources
  are revoked and a subsequent offline migration publishes successfully without an
  explicit session close being needed to free its writer reservation.
- `service-review.test.ts`: engine-compatible bound adapters construct option-based
  launches in two distinct selected homes, mask ambient credentials, preserve composed
  session environment, expose the instance ID, and refuse unpinned resume.
- Existing quota fixture tests now admit their fixture bytes through `ProviderPayload`.
  Recorded fixtures, timezone, scheduler, collisions, lineage and source hash guards remain.

The source tests were written before their corresponding production changes. They
were not executed to demonstrate red/green, per the owner's overriding instruction.

## Mutation cases

All cases below are **not executed (tests run at merge)**. No fault was applied or
claimed killed in this follow-up. The prior 25-case audit remains historical evidence.

| Fault                                                             | Designed guard                                 |
| ----------------------------------------------------------------- | ---------------------------------------------- |
| Accept arbitrary object maps before enumeration                   | Untrusted ingress enumeration/read traps       |
| Remove encoded byte-length guard                                  | Oversized byte-array refusal                   |
| Remove UTF-8 byte-length guard                                    | Multibyte encoded refusal                      |
| Skip nested immutability                                          | Nested replacement refusal after certification |
| Accept missing frame certificate                                  | Uncertified adapter data never forwarded       |
| Accept certificate/data mismatch                                  | Mismatched adapter data never forwarded        |
| Clear overflow on incremental existing-window update, verifier N4 | Existing `w0` remains exhausted                |
| Omit natural-exit writer release, verifier N13                    | Migration after natural exit publishes         |
| Omit lifetime revocation on natural exit                          | Exit observer sees resource revocation         |
| Construct native adapter before assigning env                     | Real option-based CLI observes selected home   |
| Permit unpinned cross-instance resume                             | Bound adapter refuses unpinned resume          |

## Performance and failing checks

`bench/quota.ts` now measures bounded payload admission, oversized wire refusal,
uncertified large-map refusal, certified quota folds, certified delta forwarding,
persisted updates and status lookup. It has not been run. New numbers **need run at
merge**. Old ingress/delta timings predate the certificate boundary and cannot validate
the new implementation. The unchanged streamed-copy benchmark retains its historical
observations only.

The verifier's default-deadline failures are retained as failures. This follow-up did
not rerun them or probe `origin/main`, so it makes no new claim that they are unrelated
or flaky. The earlier head passed with runner-only deadline headroom; that is not a
passing final-head check. Runtime checks **need run at merge**. Test deadlines and
the core thread-status precedence are unchanged here.

## Integration rehearsal I7

Accounts supplies `bindAdapter(factory, assignmentFor?)`, so the engine can register
a normal `ProviderAdapter` whose `openSession` cannot bypass account assignment. The
native factory receives the selected environment and context before constructing
option-based adapters. Engine composition must resolve models for `context.instanceId`,
prepare plugins/context, and acquire MCP resources through their public APIs there.
All lifetime-bound leases can use `context.signal`; accounts revokes that lifetime on
natural exit and completed close. Adapters must report exit only after their complete
process tree is gone.

The engine and native adapters are not yet on `origin/main`. This PR does not merge
their unreviewed branches or claim their daemon registration and input composition
are implemented. Their owner must register the bound factories, persist the returned
session instance ID with the native ID, and emit certified frames from encoded native
transport data. Full combined execution **needs run at merge**. See the integration
instructions in the package README.

Independent-process exclusion remains a disclosed scope limit. The default daemon
refuses migration; a verified exclusive offline lease is required. Native lock absence
and a process-table snapshot do not prove future quiescence. No independent-writer
detection or automatic live failover is claimed.
