# 0043: Keep local Cursor on ACP until the SDK meets ace's provider boundary

Date: 2026-10-02. Status: Proposed.

## Context

The user asked whether ace should replace Cursor's ACP integration with the
official Cursor SDK. The [SDK audit](../research/providers/cursor-sdk.md) inspected
`@cursor/sdk` 1.0.35, Cursor's official docs and bridge protocol, the installed
`agent` 2026.09.26-dd393fe, and the adapter on `integration/train-1` at
`8d98459e20c181d93abb269cc12d1df5a28ff75a`.

The SDK supports both local and cloud execution. Local mode embeds the agent
runtime in its Node host. It uses API keys, including keys minted and stored
through `Cursor.auth.login()`. It does not launch the user's installed CLI or
reuse that CLI's login. [Research authentication evidence](../research/providers/cursor-sdk.md#authentication-and-process-ownership).

[ADR 0002](0002-local-cli-providers.md) is binding. ace drives the user's locally
installed, logged-in CLIs; it neither collects provider credentials nor offers
provider login. SDK-owned browser login and an SDK sidecar do not satisfy that
boundary.

The SDK gives ace useful capabilities: acknowledged steering, structured errors,
tool names and token usage. It also removes existing interaction behavior. Local
SDK runs deny approvals requiring a human, reject interactive questions, and
accept plan creation without a plan-review callback. Nested task deltas do not
provide a complete recursive transcript. [API and source comparison](../research/providers/cursor-sdk.md#comparison-with-the-findings-in-cursormd).

ACP already provides observed child-session routing, mode/model control and plan
review. It has real gaps: diagnostic text in place of structured failures, no
token feed, and background shells whose completion is not observable. ACP root
sessions did not write JSONL transcripts in the existing recordings. These limits
remain explicit; retaining ACP does not declare them solved.
[Recorded evidence](../research/fixtures/cursor.md).

## Proposed decision

1. Keep provider kind `cursor` backed by the generic ACP adapter's Cursor quirks.
   Resolve the user's installed `agent` and run `agent acp` with that CLI's
   existing login. Continue one owned process per thread/workspace.
2. Require protocol v1 and an advertised subagent capability after requesting
   `_meta.subagents`. If the installed Cursor cannot supply that evidence,
   report incompatibility before admitting a prompt. Decode unknown fields and
   extensions leniently and retain raw data.
3. Keep native steering, fork, token usage and individual background-task control
   unavailable. Use ace's queue. Preserve pending human interactions, observed
   child lifecycles and uncertain cancellation/background work under
   [ADR 0004](0004-canonical-agent-model.md).
4. Use ace's event log for the history of ace-owned threads and ACP `session/load`
   for continuation. Preserve existing native IDs. General Cursor history import
   stays unsupported for this delivery. A later read-only transcript supplement
   needs an explicit partial-history contract and independently verified ACP
   resume identity; transcripts cannot prove live completion.
5. Do not add `@cursor/sdk`, SDK credential discovery/login, or a Cursor Cloud
   provider as part of this work. A separate cloud provider would still require
   an explicit decision superseding the applicable parts of ADR 0002. No hosted
   ace mode is proposed.
6. Reconsider SDK adoption when official evidence establishes an installed-CLI
   login/execution path, interactive approval/question/plan callbacks, adequate
   child lifecycle reporting, and a migration path for existing native sessions.

## Implementation and migration

Carry the train's `packages/adapter-acp` and daemon registration forward. Harden
the Cursor initialize check within the existing session shell; preserve shared
ACP translation, queueing and process supervision. Keep the engine contract and
stored ACP identities. The [research migration plan](../research/providers/cursor-sdk.md#migration-from-integrationtrain-1)
names the current source owners and behavior to preserve.

The worker brief is `/tmp/ace-orch/impl-cursor-brief.md`. It lists offline behavior
tests and fixture scenarios that need the owner's explicit approval before
recording. This proposal does not authorize spending subscription quota.

## Consequences

Existing Cursor threads remain resumable through the same transport. ace retains
the human interaction channel and observed subagent tree without adding a second
provider credential store.

SDK-only steering and usage remain unavailable. Background-shell visibility is
still incomplete and must stay visible as a limitation in client behavior.
Improving that requires separately approved recordings of a provider-owned
completion signal, not inference from assistant prose or a success stop reason.

Implementation knowledge comes from primary provider sources and ace's own
specifications. No vendor SDK implementation or unaccepted third-party code is
copied into ace.
