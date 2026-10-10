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

Use available local model identifiers. `accountId` selects an accounts-scheduler instance; omitted selection uses eligible managed instances or the user's default logged-in CLI when no instances exist. Options are adapter capabilities: Codex supports effort and service tier; Claude supports its SDK effort values. Other adapters reject unsupported options. ACP sessions receive ace MCP through their advertised HTTP or stdio transport.

`wait: true` observes settlement inside the call. `wait: false` returns the child ID immediately. Both produce a durable, coalesced result turn with trigger `subagent_result`. A timed-out observer leaves accepted work running. Follow-up messages retain the same native child thread and use a new durable result generation. Retrying a completed follow-up does not start another turn. Results contain small excerpts and transcript paging pointers. A parent can receive one completed child's result while other children remain active; its own approval or background task still prevents delivery.

`thread.create` prepares a child without opening a provider session. `thread.launch` starts it. Message, interrupt, read, search, and wait operate on independent threads. Reads are limited to the workspace or delegation family. Mutations require the caller's thread or a descendant. A child cannot mutate a parent or sibling. Only `question.answer` can resolve interactions: both the incoming answer and stored request must be questions. Approval, plan approval and elicitation resolution are unavailable.

Title, GitHub PR link, archive/settle, snooze and project name operations use the existing store and notification APIs. PR metadata is returned with paged thread reads. Settling requires a settled or unlaunched thread. Search uses the existing search API with a thread filter applied before ranking. `ace_thread_read_output` pages retained text/output sources by byte offset, returning lossless base64 bytes and the next offset; the stream must belong to the requested authorized thread.

Fork checks the adapter's `fork` capability and calls the host's registered extension. Merge and queue tools require their owning extension. This checkout has no fork/queue executors, so these operations return `unsupported`; native capability alone does not fabricate an executor.

Automation management uses `@ace/automations`, with durable ownership. Agent-created jobs support manual and schedule triggers, zero jitter and the caller's workspace; worktrees and file/GitHub watchers require host service integration. Scheduled jobs use the same delegation limits, account scheduler and result observer. Automation definitions/runs live in `agent-automations.sqlite`; ownership is claimed first in the daemon store, making interrupted cross-store creation fail closed.

Worktree handoff uses `@ace/git`: create a branch from HEAD in a deterministic daemon-owned directory and start a linked child there. It preserves the source thread and does not migrate a native session between directories. Retries reuse accepted child receipts. A provider launch that fails after acceptance retains its child-owned worktree for inspection or an explicit follow-up. Accepted worktrees remain until the user or Git owner removes them.

Preview list/close use `daemon.agentControl.previews`. A host service registers a bounded descriptor and its close callback against a thread. Unowned listener ports never appear and cannot be closed. The current preview gateway has no thread ownership API, so it is intentionally not imported as global agent authority.

Attach transcript context through a message context item:

```json
{ "items": [{ "type": "thread_ref", "threadId": "THREAD_ID", "budgetBytes": 4096 }] }
```

Each summary and pointer fits its UTF-8 byte budget; eight references and 32 KiB aggregate are the maximum. Summaries are labelled untrusted context and keep a paging cursor instead of expanding entire histories.

The daemon exports `DelegationService` and `createAgentControlPort`. `prepareInWorkspace` is a trusted host method for worktree execution and is never a wire/MCP argument. Host policy defaults: four concurrent children per parent, 64 children per root tree, depth four, one hour, one million reported tokens, $100 reported cost, and a 50 ms coalescing window. Missing usage/cost reports cannot provide exact financial enforcement. Admission also caps current children globally at 64, observers at 64, stored delegation receipts at 10,000, preview registrations at 64 and concurrent handoffs at four. Receipt capacity rejects new work rather than evicting idempotency identities.

Status and usage updates point-read a delegation edge. Root active counters and partial indexes keep deadline lookup independent of completed history. Results and accepted launch/wake receipts survive restarts. Uncertain provider sends recover as failed instead of silently replaying prompts. The engine remains the sole provider I/O owner.

113 unique tests in 19 conflict-related files passed under the owner's explicit merge-conflict exception. The full suite, mutations and benchmarks remain unrun; other behavioural claims and performance measurements need run at merge. The non-gating benchmark is `apps/daemon/bench/agent-control.ts`; it reports admission latency, status updates/s and peak RSS without real providers.

Accepted UI sends and MCP messages use the same engine command policy. A follow-up reserves a new result generation once, including concurrency/deadline accounting. Preparation validates the entire ancestor chain both when reserving capacity and when committing a reserved child, even if the caller already settled and retains a native MCP lease. Stopped ancestors deny new preparation without creating threads or linkage. An explicitly messaged settled subtree can restart after interruption; automatic result turns cannot restart a stopped subtree. Cancellation request and child generation distinguish new cascades from retries. Root cancellation remains final for that tree. A new root thread is required to delegate after cancelling the whole tree; agents cannot undo that cancellation themselves.

Worktree handoff reserves admission before Git work. Failed or revoked requests clean their newly created worktree and unchanged branch, roll back workspace creation and release the reservation. Cancellation reaches the Git lifetime and is rechecked at child acceptance. Incomplete handoffs recover through their durable cleanup intents. Changed, dirty or uncertain partial resources retain a bounded reservation and report a cleanup failure instead of being deleted. Preview close operations share their registration's cleanup promise.

Generic ACP delegation requires `acpAgentId`, `installationId` and `instanceId` from the approved registry. An optional `accountId` must match that instance; native quota scheduling does not invent ACP isolation or quota support. Claude's native MCP replacement controls and Pi's registration preserve the engine's scoped ace lease. OpenCode v2 preserves user MCP definitions and isolates processes by account and lease, because its MCP configuration is process-wide. Unscoped sessions retain the adapter's account-based server sharing. The server pool remains bounded at 128 entries with idle eviction.

Canonical client thread and Forge owners can register `AgentControlExtensions.thread` for read/rename/title/PR/settle/snooze operations. Agent scope is checked before calling the owner, and cancellation is checked after asynchronous results. The port never exposes approval operations. Unregistered owners retain this checkout's existing behaviour until their integration lands. Automation/fork/merge/queue owners use the typed `execute` port.

After fork/switch #69, prepared children use the canonical engine creation/selection owner. A switch preserves the ace thread and delegation edges, waits for its whole tree, and retains scoped MCP authority when a native session reopens. A fork records historical lineage while owning an independent delegation tree. Cancelling one tree does not cancel its lineage peers. Cancellation also rejects queued provider switches and releases queued transition guards.

MCP fork/merge operations still need a registered host bridge: their existing schemas lack the continuation and authored citation inputs required by the new engine commands. A bridge must also authorize the merge's source and account for agent-started fork work. Editable queue ports remain explicit integrations.

## Delegate to another connected device

`ace_device_list` returns available paired hosts, their projects, models/accounts
and native permission modes. Use those exact identities in `ace_device_delegate`:

```json
{
  "requestId": "review-api-on-build-box",
  "hostId": "<host ID from ace_device_list>",
  "workspaceId": "<project ID on that host>",
  "provider": "codex",
  "model": "<advertised model>",
  "accountId": "<advertised account>",
  "role": "Review API",
  "task": "Review the API against the attached design and report findings.",
  "context": {
    "attachments": ["<source thread image SHA-256>"],
    "files": ["docs/api-design.md"],
    "threadBudgetBytes": 4096
  }
}
```

The target receives a parent transcript snapshot and immutable selected files
through the encrypted files relay. Paths in `context.files` are relative to the
source thread environment; they are never interpreted on the target. Selected
attachments must already belong to the source thread. Use `ace_device_task_status`,
`ace_device_task_wait` and `ace_device_task_cancel` with the returned `id` as `taskId`.
Only the originating parent agent can inspect or control that task.

A connected client brokers the existing paired-host workers, so client or device
disconnection shows unavailable until recovery. A target files relay must be
configured for context transfer. Status and bounded text results return to the
originating agent; output artifacts remain on the producing device. This does
not copy workspaces or merge remote changes. Cross-device descendants cannot
recursively delegate to a third host. See [ADR0071](adr/0071-cross-device-agent-delegation.md).
