# Delegation transcript items

The daemon publishes delegation items through the existing `item.created` and
`item.updated` events. They are included in snapshots, `items.page`, `items.window`,
and MCP transcript reads. The parent agent owns the item. The child thread remains
independent and owns its transcript and process.

Render `delegation.started` as an inline child-thread card. Its stable `id` is
updated from admission through launch, human waits, cancellation and settlement.
Use `childThreadId` to open the child. Display `title`, `role`, `provider`, optional
`model` and `accountId`, `phase`, and the canonical `status`. `updatedAt` is the latest
status update. `generation` increases when the child receives follow-up work.
`complete` is false until the delegation settles. `outcome` is null while live,
otherwise it contains `threadId`, `outcome`, `result`, `truncated`, and `before`.
Do not infer completion from an assistant message or from the parent's turn ending.

Render `delegation.settled` as an ace event row, never as a user bubble. It has
`origin: "ace"`, `delivery: "tool" | "ace-input"`, and `results`, an array of short
outcomes with `threadId`, `outcome: "completed" | "failed" | "cancelled"`, `result`,
`truncated`, and `before`. These summaries are bounded; open the child or page its
transcript for the retained result. Both kinds also carry the standard item fields
`id`, `agentId`, optional `runId`/`executionSource`, `createdAt`, and `complete`.

Waiting calls return the full bounded outcome through their MCP tool result and
consume the pending wake. A canceled wait leaves the child running and allows an
asynchronous wake. Codex uses `additionalContext` with `kind: "untrusted"`; Pi uses
its extension's custom-message API; Claude's SDK accepts only user-role streamed
input and receives `isSynthetic: true`. Other user-input transports receive an
ace-origin marker. The daemon retains attribution and folds native user-role echoes
and replay into the ace item, preserving provider raw data.

Provider interfaces are based on the installed Claude SDK `SDKUserMessage` and
Codex's generated `TurnStartParams`, plus Pi's primary
[extension API](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md).
Child text remains untrusted context regardless of the transport channel.
