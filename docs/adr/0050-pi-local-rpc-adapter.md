# 0050: Pi through the installed local RPC runtime

Date: 2026-10-02. Status: proposed. Depends on ADRs 0002, 0004 and 0007.

## Decision

Use the user's installed Pi executable in RPC mode. The inspected version is
0.85.1, from `@earendil-works/pi-coding-agent`. Keep the translator pure and the
session on provider-kit. No provider SDK or credential store is embedded in ace.
Research and primary references live in [the Pi notes](../research/providers/pi.md).
The competitor release was read only as a feature inventory, never as implementation.

Gate support to the inspected 0.85.1 release. Unknown versions fail before opening
a session rather than assuming that newer documentation describes an older binary.
Automatic discovery runs `--version` only and leaves authentication unknown.
Pi also has a provider-specific `auth check --json --no-refresh`; ace does not
select an arbitrary LLM provider or inspect credentials during discovery. Login remains
Pi's interactive `/login` on the local machine. Never read auth files.

## State and native history

Only `agent_settled` ends the root run. `agent_end` can be followed by compaction,
retry or queued input. Open dialogs and surviving tool calls keep whole-tree
status live. Unexpected process exit expires interactions through core. Unknown
frames are retained as raw notices; unknown tools remain custom tools.

Resume uses the native session file returned by `get_state`. Fork uses `clone`
or `fork(entryId)`, reads the resulting file and switches back to the source.
Rollback uses an explicitly loaded ace extension command calling Pi's
`navigateTree` without summarization. It changes conversation context, not files.
The adapter exports optional native history controls alongside ADR 0007's session
contract. The daemon registers bounded, operate-scoped Pi controls through its
service registry; these return native references for the generic fork worker.
They do not claim to create a second canonical ace thread.

Pi's `prompt.streamingBehavior` implements steering and follow-up. ace's durable
engine queue remains the owner of ordinary queued delivery. Interrupt clears
Pi's queue before aborting. Pi 0.85.1 has no standard native subagent protocol;
third-party extensions cannot be inferred from tool names. Declare background
visibility none and transcript/control support false. ace MCP child agents stay
owned by the existing orchestrator contract.

## Permissions, extensions and MCP

Pi 0.85.1 has no built-in supervised, edit-only or permission-popup mode.
Its `--tools` is a tool allowlist; `--approve` concerns project resource trust.
Advertise unrestricted execution and read-only built-in tools accurately.
Supervised and edit-only requests fail visibly. Read-only disables user extensions
and loads only the ace control extension; it supplies read/search built-ins and
no MCP tools. This is a provider tool restriction, not an OS filesystem sandbox.
Default operation keeps Pi's normal skills, prompt templates and extensions.

Map select/input/editor extension dialogs to questions and confirm to yes/no questions.
Only these four methods block. Reply by native id, validate offered values, and
expire timed dialogs with an injected scheduler. Fire-and-forget UI updates become
notices. Timed or answered requests cannot be answered again.

0.85.1 has no built-in MCP. An ace-owned extension registers tools from ace's
bounded authenticated loopback MCP endpoint. Session-scoped lease material enters
only the child environment, is redacted before frame publication and is revoked
on every exit and opening failure. No provider credentials cross this boundary.
Control commands are authorized by an unguessable per-process secret in memory;
model-generated slash commands cannot invoke rollback.

## Bounds and verification

Strict LF JSONL preserves Unicode separators. Reuse provider-kit's bounded write
owner, with caps on lines, outgoing requests, dialogs and active tool tracking.
Delta translation is proportional to each delta. Cumulative tool output contributes
only a suffix, tracked by length, with no accumulated output retained in the adapter.
Fail closed on live bookkeeping overflow rather than dropping work and reporting done.
A non-gating benchmark source covers frame translation and LF framing. Measurements,
behaviour tests and at least eight documented mutation cases need execution at merge,
per the owner's rule. Recorder scenarios are written for approval; no fixtures are
recorded and no prompts are sent during implementation.
