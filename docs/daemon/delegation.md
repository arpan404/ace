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
ace-origin marker as a readable transport label. Text is never an attribution credential.
Before sending input, adapters call `SessionContext.onInputMessage` with the host
command ID and the exact message identity projected in `draft.nativeId`. The daemon
stores this correlation under a thread/message primary key, including an explicit
`user` origin for ordinary commands. It folds correlated ace echoes and native
replay into the settled item, preserving provider raw data. Handoff, merge and
attachment preparation can change the input parts without changing attribution.
Copying the marker or the entire prompt in a user command remains user input.
Uncorrelated historical input is preserved as user input; ace does not guess
identities for older records. Attribution rows cascade away when the thread is deleted.

Provider interfaces are based on the installed Claude SDK `SDKUserMessage` and
Codex's generated `TurnStartParams`, plus Pi's primary
[extension API](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md).
Child text remains untrusted context regardless of the transport channel.

Known provider `notice` items carry readable `text` and optional `details` with
`code`, `provider`, and optional `model`. Show the message as the notice and expose
the code in details. Failed agent statuses carry the same optional `error.details`.
Unknown errors retain their original text. Provider evidence remains in `raw`.

Ace approval targets carry `origin: "ace"`, an exact `description`, and `riskClass`:
`read-only`, `thread-write`, `agent-execution`, or `external-effect`. Display the
description as the action; validated reads resolve automatically, including in ask
mode. Read-only mode denies writes and execution.

## UI follow-up for the Claude web agent

No renderer is changed in this backend PR. Add renderers for both item kinds and
child navigation in web/desktop, including navigation and reconnect coverage.
Use `ClientApi.thread(parentId)` to acquire the live `ThreadSource`, select `order`
and `item:<id>` keys, and read each entry with `ThreadReader.item(id)`. Release
the lease when leaving the thread. Open the card's `childThreadId` with
`ClientApi.thread(childThreadId)`. Use `ClientApi.itemsPage` for older retained
entries and `ClientApi.itemsWindow` for long-thread navigation; both retain these
item kinds. The `delegatedDocs` fake-daemon scenario publishes running cards and
settled rows for this work. Show `notice.details.code` in expandable details.
