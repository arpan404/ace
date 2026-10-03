# 0050: Scoped agent control and durable cross-provider delegation

Date: 2026-10-02. Status: accepted for implementation.

## Context

Agents need to delegate to another local provider while preserving each provider's native history. ADR 0004 requires completion to include the entire tree. ADR 0007 makes the engine the sole owner of provider execution. ADR 0010 binds MCP callers to ephemeral thread and agent credentials. The Orchestrator V2 release notes are a feature reference only. No t3code or legacy source was read.

Number 0050 follows the highest number in origin/main, 0049. Open PRs 62, 63 and 64 use 0045, 0046 and 0044 respectively at allocation time.

## Decision

Add schema-only agent-control contracts and exports. Delegation policy and result formatting belong to @ace/orchestrator, with injected time and identifiers. The daemon registers its service through ordered composition, without editing server.ts. Deck can call the same public delegation service instead of spawning a second kind of child.

A delegated child is an independent engine thread with its own native session. A durable edge records its parent thread and authenticated parent agent, role, requested model/account, options and request receipt; the engine session row persists the scheduler-selected account. The parent tree contains a summary agent pointing to the child thread. That agent derives status from the child's whole thread, including grandchildren, questions, approvals, queues and background work. Parent process exit cannot terminate independently owned child work. Child transcripts remain paged in their own threads.

Admission commits the edge, engine creation intent and parent linkage together. Thread creation supports a caller-owned idempotent identity at the trusted engine boundary. A launch failure is a reported result, never invisible work. Account selection uses the accounts scheduler and persists its assignment before launch. Explicit exhausted or mismatched accounts are rejected. Default local accounts remain usable when no managed instances exist. Launch options are bounded, schema-validated and capability-gated by the adapter; unsupported option keys fail before creating a thread, and provider-specific values are validated before opening a CLI session. Options never carry provider credentials or permission grants.

Per-thread concurrency, root-tree child count, depth, elapsed time, tokens and reported cost have host-owned caps. Child input cannot raise those caps. Admission and completion use indexed rows and counters. Cancellation records durable control intents and visits descendants in depth order. Interrupt acceptance alone does not prove termination. Stopping pending input prevents a cancelled child from launching later. A stopped parent suppresses result wakes, but child outcomes remain readable.

Completion is based on aggregate thread settlement, not run end. A short injected timer coalesces completions for the same parent. Pending results survive restart. One durable command carries each batch and its stable command id, including each child's result generation. Accepted follow-up messages reopen a settled edge inside their command receipt and preserve its native thread; retried messages never reopen it a second time. It starts a queued parent turn with trigger subagent_result after the parent's own foreground work settles. Linked children do not prevent that result turn from running. Human approval or background work in the parent's own provider still prevents delivery. Results contain bounded excerpts plus thread/item pointers. Reads and waits do not consume results. An agent may choose to await a child inside the tool call or continue and receive a later wake. Tool timeout only ends the observer; accepted child work survives.

Restart never silently repeats uncertain provider sends. Engine recovery reports uncertain delivery. The delegation journal reconciles existing children, retains pending starts and unconsumed results, and reuses committed command receipts for wakes. Uncertain children report failure with their retained transcript rather than a false success or an extra provider session.

## Authorization and thread tools

MCP authority always comes from the lease, never input attribution. Read and write access are limited to the caller's workspace and delegation family. A child can read its ancestors and siblings but cannot interrupt or mutate them. A parent can control descendants. Independently created threads are registered as owned children before launch. Project operations can only address the caller's registered workspace, and never accept arbitrary paths.

Expose create, launch, message, wait, paged read, search, interrupt, question answer, title updates, PR links, settle, snooze, automation/project management, worktree handoff and preview list/close through typed service ports. Question answering validates both the stored request kind and the answer kind immediately before accepting the existing engine resolution command. No approval, plan-review, elicitation, review approval, conductor approval or arbitrary-command tool is exposed. Even a parent cannot approve a child's permission request.

Fork/merge and queue edits/reordering call their owning service when registered. Missing services return an explicit unsupported capability result, including when an adapter advertises native fork but no fork executor exists. Manual/scheduled automation jobs use the existing automation owner with zero jitter and durable thread ownership. Worktree handoff uses Git's worktree owner and starts an independent linked child. Host-registered preview descriptors carry thread ownership and close callbacks; unowned gateway/listener ports remain inaccessible. File/GitHub automation triggers require host integration. Optional feature ports also fail closed when the daemon has no executor. This avoids competing implementations while parallel feature branches land.

Add context items of type thread_ref. The context owner resolves an authorized reference to a bounded summary and paged transcript pointers. Attached content is labelled untrusted data and does not expand write authority. Resolution has an aggregate byte budget and preserves an explicit truncation marker.

## Bounds and verification

No streaming delta scans delegation history. Status/usage events point-read their owning edge and update only changed ancestors, bounded by depth. SQLite owns durable history, indexed active counts, result batches and deadlines. Prepared statements are reused. At most 64 children per tree, 8 levels, 64 observers and one service timer for indexed result/deadline work are retained, with rejection/backpressure at capacity. Delegation receipts reject admission at 10,000; current children across roots are capped at 64. Paged tools cap both item counts and bytes. Results retain previews, never full output buffers.

Write adapter-testkit behaviour tests for cross-provider wait/wake, batched completion, whole-tree waiting, cascading cancellation, concurrency/depth/budget rejection, question-only authorization and restart reconciliation. Add non-gating benchmarks for delegation admission and change-driven completion propagation. The repo owner's latest rule prohibits local tests, probes, mutation runs and benchmark execution. Run only formatting, lint, type and source-size checks. Document at least eight mutation cases as not executed, tests run at merge. Runtime and performance numbers need run at merge.
