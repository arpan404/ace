# Offshift

`@ace/offshift` owns the local coding workflow record. The daemon exposes it through
`ace_offshift`, scoped to the authenticated caller's thread. The bundled `offshift`
skill supplies the execution procedure to native skill loaders and `ace_guide`.
No Python installation, optional control-panel process or user-installed skill is required.

The agent performs work using existing ace tools and its installed provider CLI.
This package records the outcome, authorized endpoint, acceptance criteria, phase,
blocker and latest evidence. It does not launch providers, schedule background turns,
resolve approvals, publish code or expand the authority granted by the user.

Start a run with `request: {action: "start", runId, requestId, outcome, endpoint,
criteria: [{id, description, requiredKinds: ["automated", "source"]}]}`.
Read it with `request: {action: "get", runId}`. `list` returns summaries capped at
128 Unicode characters with `outcomeTruncated`; use `get` for the full outcome.
Every run view includes a current host-captured source revision and canonical tree observation. Advance in order
through `plan`, `implement`, `verify`, `review`, `delivery`; earlier phases can be
revisited after findings. Mutations after start require `version` and `requestId`.
Retry the identical request after a lost response. Reusing its ID for different
input is rejected. The replay returns the current view, not an old completion.

Before checking behavior, retain the revision from `get`. After the check, submit
`action: "evidence"` with `evidence: {criterionId, kind, result, revision, action,
artifact, note}`. `artifact` identifies retained evidence; it is a reference, never
an instruction for the daemon to open a path or execute a command. Record evidence
truthfully. The daemon checks freshness and completeness, not whether an agent's
claim is authentic. Failed observations replace earlier passes for that kind.

Delivery requires current passing evidence for every required kind. Completion is
an observation, not a persisted success flag: phase must be delivery, evidence
must still match, there must be no blocker, and the whole tree must be done.
Revival, background work and human waits prevent completion. During the agent's
final tool call, `waiting_on_tree` is expected until the agent itself settles.
Readiness does not schedule another turn or imply work continues after the host stops.

`OffshiftJournal` accepts the host's synchronous SQLite transaction port. It stores
runs and request receipts atomically in the daemon database. Deletion cascades with
the owner thread. Transcript retention also purges the outcome, evidence and receipts.
It retains at most 32 runs per thread, 512 mutations per run,
64 criteria, five evidence kinds per criterion and 48 KiB per run. There is no
history-sized work on provider deltas. Explicit status/evidence calls snapshot
tracked and nonignored source contents using `@ace/git`; ignored outputs and external
services need their environment identity recorded in evidence. Source capture fails
closed when Git cannot represent the checkout. The real index is preserved.

Behavior tests cover the public journal and real SQLite persistence. Development
uses static checks; test execution follows the repository's merge-only policy.
