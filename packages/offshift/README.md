# Offshift

`@ace/offshift` owns the local coding workflow record ([ADR 0090](../../docs/adr/0090-native-offshift.md)).
Agents reach it through the `offshift` tool in its own `offshift` family, scoped to the
authenticated caller's thread. Nothing loads it upfront: ace's MCP instructions mention it, and an
agent loads the procedure and the tool with `guide` topic `offshift`. No Python installation, control-panel process or user-installed skill is
required.

The agent does the work with ace's other tools and its installed provider CLI. This package
records the outcome, authorized endpoint, acceptance criteria, phase, blocker and latest evidence.
It does not launch providers, schedule background turns, resolve approvals, publish code or expand
the authority the person granted.

Start a run with `{action: "start", runId, requestId, outcome, endpoint, criteria: [{id,
description, requiredKinds: ["automated", "source"]}]}`. Read it with `{action: "get", runId}`.
`list` returns summaries capped at 128 Unicode characters with `outcomeTruncated`; use `get` for
the full outcome. Every view includes the current host-captured source revision and canonical tree
observation. Advance in order through `plan`, `implement`, `verify`, `review`, `delivery`; earlier
phases can be revisited after findings. Changes after start require `version` and `requestId`.
Retry the identical request after a lost response; reusing its id for different input is rejected.
The replay returns the current view, never an old completion.

Before checking behaviour, keep the revision from `get`. After the check, submit `action:
"evidence"` with `evidence: {criterionId, kind, result, revision, action, artifact, note}`.
`artifact` identifies retained evidence; it is a reference, never an instruction for the daemon to
open a path or run a command. The daemon checks freshness and completeness, not whether an agent's
claim is authentic. A failed observation replaces the earlier pass for that kind.

When a requirement changes, `{action: "revise", runId, requestId, version, criterion, note}` adds
the criterion or replaces the one with its id, and drops that criterion's evidence. A run holds at
most 64 criteria; revising is refused while it is blocked.

Delivery requires current passing evidence for every required kind. Completion is an observation,
not a stored flag: the phase is delivery, evidence still matches, there is no blocker, and the
whole tree is done. Revival, background work and human waits prevent completion. During the
agent's final tool call, `waiting_on_tree` is expected until the agent itself settles.

Each successful change also publishes a bounded card of the run (`runCard`) as an
`offshift.updated` thread event, so the person sees the latest run in the Summary tab, worded
against the whole tree.

`OffshiftJournal` takes the host's synchronous SQLite transaction port and stores runs and request
receipts atomically in the daemon database. Records cascade with the owner thread and are purged
with transcript payloads. It keeps at most 32 runs per thread, 512 changes per run, 64 criteria,
five evidence kinds per criterion and 48 KiB per run. Explicit calls snapshot tracked and
nonignored source with `@ace/git`; the real index is untouched. A workspace Git cannot snapshot
answers `unavailable` instead of recording evidence without a source.
