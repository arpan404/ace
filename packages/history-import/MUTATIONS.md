# Mutation cases

Verification for this revision is not executed (tests run at merge). The owner prohibits local test, mutation, probe and benchmark execution. Static review maps each production change below to a public behaviour assertion; whether it kills the mutation needs run at merge. The merge-time runner restores source bytes and rejects syntax, import and timeout failures as evidence.

| Production mutation                         | Behavior test                                                                         | Result                            |
| ------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------- |
| Reread unchanged files                      | warm scans read zero content and a changed source is the only content reread          | not executed (tests run at merge) |
| Discard imported message text               | workspace lists retain native metadata and imports retain resumable provenance        | not executed (tests run at merge) |
| Lose resumable native identity              | workspace lists retain native metadata and imports retain resumable provenance        | not executed (tests run at merge) |
| Omit subagent history                       | Claude sidechains become child agents and changes are indexed independently           | not executed (tests run at merge) |
| Drop unknown raw records                    | unknown native records survive as canonical raw notices                               | not executed (tests run at merge) |
| Ignore cancellation at pull boundaries      | cancellation rolls back while a slow sink enforces pull backpressure                  | not executed (tests run at merge) |
| Never publish a committed thread            | workspace lists retain native metadata and imports retain resumable provenance        | not executed (tests run at merge) |
| Return corrupt zero-filled blob bytes       | oversized records stream losslessly into bounded blob chunks and pages                | not executed (tests run at merge) |
| Publish history after a source change       | source changes during import roll back all staged history                             | not executed (tests run at merge) |
| Invent an exact database-only count         | database metadata remains listed after its duplicate rollout is deleted on warm scans | not executed (tests run at merge) |
| Increase the page cap to 2000               | item pages refuse limits above 200 instead of silently increasing the page cap        | not executed (tests run at merge) |
| Remove final scan stability verification    | a database changed while scanning cannot publish stale sampled metadata               | not executed (tests run at merge) |
| Drop Codex result text                      | codex native results complete their call and link all output                          | not executed (tests run at merge) |
| Reread cached files without reporting reads | warm cached scans perform no actual FileHandle transcript reads even across restarts  | not executed (tests run at merge) |

Additional review regressions are designed to reject these mutations. Each case is not executed (tests run at merge):

- Discard duplicate Codex database rows, losing the fallback after rollout deletion.
- Adopt unknown Claude record IDs as resume identity.
- Skip registered-home reconciliation after restarting the index.
- Leave native type metadata unbounded and stop cursor progress.
- Include abandoned Claude parentUuid branches.
- Leave matched native calls pending or omit their linked output.
- Terminate a suspended import before returning its generator and deleting SQLite scratch.
- Omit authenticated daemon routes or transactional event-store publication.
- Archive only live engine snapshots, rejecting persisted imported threads or duplicating a retried command effect.
- Invoke a native fork before rejecting an active continuation.
- Cache a session which exits during open, or abort it when its client disconnects.
- Slice output tails through UTF-8 characters or exceed the JSON-escaped tail budget.

Verifier regressions, all **not executed (tests run at merge)**:

| Production mutation                                                        | Public behaviour regression                                                                 | Result                            |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------- |
| Fork the original import ID after a newer native branch exits              | a second fork after exit starts from the persisted native conversation                      | not executed (tests run at merge) |
| Forget the newer native ID across daemon restart                           | a second fork after restart starts from the persisted native conversation                   | not executed (tests run at merge) |
| Take the Store lease without waiting for provider persistence backpressure | every live item and exit survives publication of another imported thread                    | not executed (tests run at merge) |
| Resume native callbacks before releasing the Store write lease             | every live item and exit survives publication of another imported thread                    | not executed (tests run at merge) |
| Accept publication with an active adapter lacking the pause port           | an active adapter without publication backpressure keeps persisting after import is refused | not executed (tests run at merge) |
| Leave callback ingress paused after request cancellation                   | cancelling an import at the persistence barrier resumes live callbacks and permits retry    | not executed (tests run at merge) |
| Reread unchanged JSONL through readFile without incrementing counters      | warm cached scans perform no actual FileHandle transcript reads even across restarts        | not executed (tests run at merge) |
| Reread unchanged JSONL through streams without incrementing counters       | warm cached scans perform no actual FileHandle transcript reads even across restarts        | not executed (tests run at merge) |

The warm-cache preload observes FileHandle.read/readFile/createReadStream, fs.promises.readFile, callback fs.readFile and fs.createReadStream. The merge-time runner includes readFile and stream reread cases. The two observed APIs added by the verifier note still need execution coverage at merge; no new mutation kill is claimed.
