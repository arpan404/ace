# 0004: Canonical agent model

Date: 2026-10-02. Status: accepted (schemas in `packages/protocol` are the source of truth).

## Context

Provider research ([overview](../research/providers/README.md)) found that no provider reports the status of a whole agent tree. Every provider has work that outlives a turn, agents start turns without being asked, and subagent visibility ranges from full transcripts to a single tool call.

## Decision

1. **Agents form a tree.** Provider subagents and ace-spawned agents are the same entity, with `parentId` and an `origin`. Each agent records its `fidelity`: `full` (live transcript), `summary` (start, end, result) or `placeholder` (only the spawning tool call).
2. **ace derives status.** Adapters report facts per agent: turn boundaries, open interactions, background tasks, retries. The daemon folds them over the tree. A thread is done only when every agent is idle, no interaction is open, no background task is live and no input is queued.
3. **Agent status is explicit and carries a reason:** `starting`, `working{activity}`, `blocked{on: human | subagents | background_task | rate_limit | network}`, `idle`, `interrupted`, `failed`, `unresponsive`.
4. **Background tasks are entities** (`shell`, `monitor`, `subagent`, `other`), not flags, so they can be listed and stopped.
5. **Runs record their trigger:** `user`, `background_completion`, `subagent_result`, `goal`, `queue`, `schedule`, `unknown`. Adapters must accept runs they didn't request.
6. **Tool calls are typed** by kind (`shell`, `file.read`, `file.edit`, …, `custom`) and always keep the provider's complete native item as raw data.
7. **Interactions** (approval, question, plan review, MCP elicitation) have states `pending | resolved | cancelled | expired` and a `blocking` flag. The first answer from any device wins. Interactions whose provider process died become `expired`.
8. **Capabilities are declared per adapter** (steer, interrupt cascade, fork, resume, usage, …). Clients read them instead of checking provider names.
9. **Everything is an append-only event log** with a host-wide sequence number. Clients sync with snapshot plus replay from a sequence.

## Consequences

- Adapters stay thin: translate native frames into facts, nothing more. Tree building, status derivation, error-text classification and liveness timers are shared daemon modules.
- Adapter correctness is checked against recorded fixtures (ADR 0005).

## Amendment, 2026-10-02

The first recorded fixtures ([summary](../research/fixtures/README.md)) confirmed the model and added these details:

- the `spawn` and `parent_agent` run triggers;
- the `upstream` blocked reason;
- ambient background tasks;
- `Capabilities.backgroundVisibility`;
- late linking of spawned agents;
- dismissed and cancelled interactions.

They also settled one rule: an interrupt only makes an agent `interrupted` once nothing it started is still running. Anything still running becomes a background task.
