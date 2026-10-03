# Fork/switch integration contract after PR #69 review

The branch merges `origin/main` at fd65555, preserving ACP registry metadata,
dynamic capabilities and native coding configuration. Migration 10 accepts
either migration-9 owner (`acp` or `transitions`), adding only missing columns.
Migration 11 retains text revisions independently of the current item and uses
one indexed append target. Public-store tests cover both installed schemas.

Run/item `executionSource` is additive. Points without proven native ownership
use portable handoff. Adapters opt into supported `forkPoints`; an unsupported
point cannot be guessed from the current native session. End snapshots guard
and close the source through native opening. The new fork remains an independent
execution root, with lineage stored separately from its parent relationship.

Cursor #67 is still a parallel PR. This branch supplies
`@ace/context.portableContext`, backed by `@ace/handoff`; retain this facade when
combining the two branches and remove Cursor's independent selection policy.
The facade requires `source.throughSeq` and `source.totalItems`, rather than
inventing a cutoff or an omission count. Its caller should capture
`store.headSeq()`, obtain `store.historicalItemCount(source.id, cutoff)` and a
`readHistoricalItemPage` at that cutoff in the acceptance transaction. Grant the
created recipient that source/cutoff through the existing `HandoffAccess` owner.
For normal `thread.fork`, the engine already performs all of those steps; Cursor
does not need its own fork selection path. Facade text is the cited JSON manifest,
so Cursor's older tests expecting a prose footer should use manifest fields.
The two facade tests here cover its byte budget, provenance, omissions, paging
cutoff and bounded iterator consumption. Integration execution needs run at merge.

Preserve the client-gaps worker's additive create receipt, account/mode/options/
baseBranch fields and send model/options during its separate train merge. This
branch does not replace the organization-command service or edit `server.ts`.

Historical page/chunk access seeks immutable metadata and sequence-bounded byte
lengths. Retired source bytes are retained until thread deletion. Missing legacy
prefixes fail visibly rather than substituting the current preview. Source
counts seek incremental ordinals; stream deltas write one length row and use the
existing chunk storage. Prepared statements have a fixed, constant query set;
no history-sized memory index is introduced.

Non-gating benchmarks are written in `packages/handoff/bench/selection.ts`,
`apps/daemon/bench/thread-transitions.ts` and
`apps/daemon/bench/history-revisions.ts`. The latter reports append and bounded
count/page costs with 100 and 10,000 historical items. Ops/s, microseconds/op and
peak RSS are **unmeasured: needs run at merge**. No runtime tests, probes,
mutations, benchmarks, provider prompts, recorder or CI checks were executed.
Only the owner's permitted static checks are development gates.
