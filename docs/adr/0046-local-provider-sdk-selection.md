# 0046: Choose official provider SDKs by capability and local CLI ownership

Date: 2026-10-02. Status: **Proposed**.

## Context

The owner wants official SDKs wherever they give the best coding experience.
An SDK can simplify process and protocol handling, but it can also hide
approvals, child transcripts or reconnect information. ace must preserve those
behaviours before reducing integration code.

The [SDK audit](../research/providers/sdk-audit.md) compares current official
implementations against `integration/train-1` at
`8d98459e20c181d93abb269cc12d1df5a28ff75a`. It checks the installed tools and uses
only source reads, help/version commands and non-prompt probes.

[ADR 0002](0002-local-cli-providers.md) remains binding. ace drives the user's
installed, logged-in tools. It does not bundle substitute provider runtimes,
create a login flow, collect keys, extract OAuth tokens or offer hosted provider
sessions. [ADR 0004](0004-canonical-agent-model.md) requires completion to reflect
the entire tree. [ADR 0007](0007-adapter-and-engine-contract.md) keeps pure
translation separate from supervised I/O.

## Proposed decision

1. Keep the official Claude Agent SDK's supported `query()` API. Pin the audited
   current wrapper after compatibility review, retain the explicit path to the
   user's `claude`, and detect optional features from initialization metadata.
   The removed V2 preview is not a migration target.
2. Complete Claude's public SDK integration for MCP configuration/status,
   elicitation, permission metadata, interrupt receipts, native fork and
   accounting. Distinguish per-agent turn usage from cumulative inclusive
   provider-session/model totals. Do not count children twice.
3. Give live Claude sessions an explicit normal coding configuration using the
   Claude Code prompt preset and selected local settings sources. Retain an
   explicit isolated configuration for metadata discovery and tests. Carry
   human input provenance truthfully; scheduler and agent content is not human
   input. Enable steering only after its priority and background-work behaviour
   is verified with owner-approved fixtures.
4. Replace duplicate Claude model-discovery control parsing with the official
   SDK's initialization-only `supportedModels()` path, using a shared public
   process bridge and bounded cleanup. Never send a dummy prompt for discovery.
5. Keep the user's `codex app-server` as the primary Codex interface. The audited
   TypeScript SDK wraps `exec --experimental-json`; it cannot replace interactive
   approvals, steering or full child-thread events. Complete native fork/review,
   model-tier delivery and rate-limit service integration through existing ace
   owners. The Python app-server SDK does not justify another runtime here.
6. Keep Gemini on the user's `gemini --acp`. The inspected Gemini CLI SDK embeds
   core instead of driving the installed executable, is not published at the
   inspected npm registry name, and restricts several CLI capabilities. The
   Google GenAI SDK is a model-service client, not the local CLI integration.
7. Keep installed Qwen on capability-gated ACP. Investigate the official Qwen
   SDK's `DaemonClient` with a compatible, user-installed `qwen serve` before
   adopting it. Do not use `Query` as the primary transport while its approval
   timeout and serial router reduce ace's human-wait and event guarantees. A
   daemon fork that launches an agent is an explicit work action, not an idle
   history clone.
8. Advertise only implemented and verified controls. Generate Codex definitions
   from the installed binary, preserve unknown native data, and handle optional
   method/feature errors. SDK presence or a newer version number alone does not
   prove capability. Do not call methods that resume or launch work as discovery
   probes.

## Consequences

There is no uniform SDK requirement. Claude keeps a package dependency, Codex
keeps its richer official protocol, Gemini stays ACP, and Qwen has a gated SDK
investigation. The audit's per-provider table records the expected effort.

Shared controls belong in engine/history/MCP/model/accounts owners, not another
adapter-specific registry. Provider-specific translation remains in its adapter.
Protocol additions are schemas and types only. Process pooling is a separate
refactor and is not required by this decision.

Normal Claude settings can load hooks, plugins and MCP servers and therefore
change tool availability. The configuration must be visible and reproducible.
SDK updates and user CLI updates are independent. Native history forks do not
copy workspace files or guarantee file-undo history.

Implementation needs behaviour tests for cancellation, reconnect, child work,
unknown events and accounting. Real fixture recording requires separate owner
approval because it spends subscription quota. This research does not authorize
recordings or claim those behaviours were live-tested.

## Alternatives considered

- Replace Codex app-server with its TypeScript SDK. Rejected because exec removes
  the interaction channel and filters the ongoing tree event stream.
- Adopt Claude V2. Rejected because upstream removed it from current releases.
- Adopt Gemini's in-process SDK or a cloud model SDK. Rejected for the installed
  CLI boundary and loss of the user's normal CLI environment.
- Adopt Qwen's streaming Query immediately. Rejected pending improvements to
  indefinite approvals and event routing. The daemon client merits a focused
  compatibility investigation.

Primary-source citations, exact package versions and unverified runtime details
are in the [audit](../research/providers/sdk-audit.md).
