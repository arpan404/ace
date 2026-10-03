# OpenCode 2.0.22 recordings

Recorded on 2026-10-03 with the installed, logged-in OpenCode CLI and
`@opencode/client` 2.0.22, using `opencode-go/muse-spark-1.3-contributor`.
The owner approved one sequential attempt per scenario. Each attempt used a
new disposable git workspace containing only the recorder's synthetic files.
No scenario was retried. Times are recorder wall times rounded to seconds,
including startup, the quiet window, history collection and cleanup.

| Scenario            | Time | Recording result |
| ------------------- | ---: | ---------------- |
| tool-read           | 12s  | Incomplete history. The execution succeeded, then cursor pagination failed. |
| approval-edit       | 13s  | Complete, including the edit permission and projected history. |
| question            | 27s  | Complete, including q0 single-choice and q1 multi-select answers. |
| subagent            | 25s  | Complete, including the child's shell permission and both histories. |
| subagent-background | 300s | Incomplete recorder settlement. Both children and the parent completed, but the original translator did not consume synthetic inbox completion metadata. |
| background-shell    | 51s  | Complete. Parent execution ended while the shell remained live; completion started a second execution. |
| interrupt           | 19s  | Complete, including interrupt acknowledgement, tool failure, shell exit and execution interruption. |
| plan-review         | —    | Skipped. The recorder and adapter explicitly do not support a configured v2 plan flow. |
| retry-overloaded    | —    | Skipped draft candidate. There is no runnable controlled overload scenario in `SCENARIOS`; no overload was induced. |

The background-subagent prompt first produced a foreground delegation. Within
the same attempt, the model then launched a second child with `background: true`.
The result arrived while the parent execution was still active. This capture
has three agents and does not establish a parent-idle interval before the
background child completes. The native shell capture does establish that interval
for shell work. Cancellation/dismissal, saved grants, cascaded interruption,
restart and reconnect remain outside these recorded scenarios.

`.expect.json` files describe native behavior through the current adapter,
core and projection. A final `done` in an expectation means the execution tree
settled; it does not certify that the original recorder collected every history
page or stopped normally. The two incomplete attempts retain their error/time-cap
notes. Their recordings were not repaired or extended with a second live run.

## Mismatches and fixes

- OpenCode rejects a history cursor combined with `order`. The recorder and
  adapter recovery now set order only on the first page. The fake HTTP boundary
  rejects the invalid combination too. Session ownership filters remain in place.
- Native `read` and `edit` inputs use `path`. Canonical tool details now retain
  that path, with the prior `filePath` fallback still accepted.
- Background results arrive as synthetic inbox entries containing
  `item.payload.metadata`. The adapter consumes completion metadata on enqueue
  and keeps undelivered input visible until delivery. Delivery into an already
  active execution clears the corresponding expected wake.
- Native shell exits now retain the event timestamp for wake reconciliation.
- Recorder settlement checks the current full-tree state after previous turn
  ends. Transport activity refreshes liveness without extending the quiet window.
- Redaction preserves literal text/delta fragments and recognized numeric usage
  counters. Opaque encrypted reasoning state is removed at the source. Other
  absolute Unix home paths are also scrubbed.
- Captures include model metadata in their header and use a model directory.
  The CLI refuses to overwrite an existing attempt. Session cleanup runs even
  if history collection fails; the original incomplete read session was removed
  separately without a model turn.

## Capture review

All seven captures passed a pre-commit scan for known credential patterns,
secret-bearing fields, personal emails, absolute home paths, the local username,
and the owner's GitHub username. Redaction is stable on every output line.
Long opaque values were reviewed without printing their contents: JSON pagination
cursors contain only message IDs, order and direction, and long permission/form
reply paths are API routes. There are no remaining scan findings. Raw recordings
and the scan report stay in ignored `.recordings/`; no credential files were read.

All seven captures were regenerated only through the source redactor. The
`1.18.33` fixtures are unchanged.
