# Agent control

ace exposes `delegate_task` and scoped `ace_thread_*` tools through each native session's loopback MCP lease. Child threads keep independent native provider histories. The parent's summary agent has `childThreadId`, and its status follows the entire child tree.

```json
{
  "requestId": "implement-parser",
  "provider": "codex",
  "model": "available-codex-model",
  "role": "implementer: follow the plan and report evidence",
  "task": "Implement the parser described in this thread.",
  "options": { "effort": "high" },
  "wait": false
}
```

Use available local model identifiers. `accountId` selects an accounts-scheduler instance; omitted selection uses eligible managed instances or the user's default logged-in CLI when no instances exist. Options are adapter capabilities: Codex supports effort and service tier; Claude supports its SDK effort values. Other adapters reject unsupported options. ACP sessions receive ace MCP only when they advertise HTTP MCP support.

`wait: true` observes settlement inside the call. `wait: false` returns the child ID immediately. Both produce a durable, coalesced result turn with trigger `subagent_result`. A timed-out observer leaves accepted work running. Follow-up messages retain the same native child thread and use a new durable result generation. Retrying a completed follow-up does not start another turn. Results contain small excerpts and transcript paging pointers. A parent can receive one completed child's result while other children remain active; its own approval or background task still prevents delivery.

`thread.create` prepares a child without opening a provider session. `thread.launch` starts it. Message, interrupt, read, search, and wait operate on independent threads. Reads are limited to the workspace or delegation family. Mutations require the caller's thread or a descendant. A child cannot mutate a parent or sibling. Only `question.answer` can resolve interactions: both the incoming answer and stored request must be questions. Approval, plan approval and elicitation resolution are unavailable.

Title, GitHub PR link, archive/settle, snooze and project name operations use the existing store and notification APIs. PR metadata is returned with paged thread reads. Settling requires a settled or unlaunched thread. Search uses the existing search API with a thread filter applied before ranking. `ace_thread_read_output` pages retained text/output sources by byte offset, returning lossless base64 bytes and the next offset; the stream must belong to the requested authorized thread.

Fork checks the adapter's `fork` capability and calls the host's registered extension. Merge and queue tools require their owning extension. This checkout has no fork/queue executors, so these operations return `unsupported`; native capability alone does not fabricate an executor.

Automation management uses `@ace/automations`, with durable ownership. Agent-created jobs support manual and schedule triggers, zero jitter and the caller's workspace; worktrees and file/GitHub watchers require host service integration. Scheduled jobs use the same delegation limits, account scheduler and result observer. Automation definitions/runs live in `agent-automations.sqlite`; ownership is claimed first in the daemon store, making interrupted cross-store creation fail closed.

Worktree handoff uses `@ace/git`: create a branch from HEAD in a deterministic daemon-owned directory and start a linked child there. It preserves the source thread and does not migrate a native session between directories. Retries recover registered worktrees and child receipts. A failed launch can leave the registered worktree available for retry. Worktrees remain until the user or Git owner removes them.

Preview list/close use `daemon.agentControl.previews`. A host service registers a bounded descriptor and its close callback against a thread. Unowned listener ports never appear and cannot be closed. The current preview gateway has no thread ownership API, so it is intentionally not imported as global agent authority.

Attach transcript context through a message context item:

```json
{ "items": [{ "type": "thread_ref", "threadId": "THREAD_ID", "budgetBytes": 4096 }] }
```

Each summary and pointer fits its UTF-8 byte budget; eight references and 32 KiB aggregate are the maximum. Summaries are labelled untrusted context and keep a paging cursor instead of expanding entire histories.

The daemon exports `DelegationService` and `createAgentControlPort`; Deck executors can use these same owners. `prepareInWorkspace` is a trusted host method for worktree execution and is never a wire/MCP argument. Host policy defaults: four concurrent children per parent, 64 children per root tree, depth four, one hour, one million reported tokens, $100 reported cost, and a 50 ms coalescing window. Missing usage/cost reports cannot provide exact financial enforcement. Admission also caps current children globally at 64, observers at 64, stored delegation receipts at 10,000, preview registrations at 64 and concurrent handoffs at four. Receipt capacity rejects new work rather than evicting idempotency identities.

Status and usage updates point-read a delegation edge. Root active counters and partial indexes keep deadline lookup independent of completed history. Results and accepted launch/wake receipts survive restarts. Uncertain provider sends recover as failed instead of silently replaying prompts. The engine remains the sole provider I/O owner.

Tests, mutations and benchmarks have not been run under the repo owner's current instruction. Behavioural and performance claims need run at merge. The non-gating benchmark is `apps/daemon/bench/agent-control.ts`; it reports admission latency, status updates/s and peak RSS without real providers.
