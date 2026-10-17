# 0065: Transcript input admission and provenance

Date: 2026-10-04. Status: accepted.

The daemon creates a complete user transcript item when it delivers a send, before
opening a provider (see the 2026-10-17 amendment: not when it accepts it). Its stable
ID is `input:<commandId>`. Clients can display a
pending send under that same ID and replace it when the daemon item arrives.
Transport loss leaves durable commands pending until a receipt or definite refusal.

Input origins distinguish the person's text from interaction answers, delegated
work, handoffs, automation, restart and limit continuation. Optional fields keep
older history readable. Echo matching belongs to the daemon, uses an indexed,
durable journal and matches the oldest sent input with the same text on the root
agent. Echoes update the admitted item, preserve original person-authored parts,
and record the provider's native boundary. They never create another user bubble.

Stop fences the run it targets and pauses queued input. Provider admission and
run completion remain distinct facts. Neither an echo nor a receipt means the
agent tree has completed.

## Review amendments

External commands always admit person-authored text and the user run trigger.
Only the in-process `Engine.internalHandler` and `Engine.spawn` paths accept
ace provenance and trusted triggers. Device IDs do not grant that authority.
An explicitly supplied title is person-authored, even when it equals the
provisional text or “New thread”. Trusted prepare commands preserve agent titles.

Claiming reserves queue work; it does not certify possible provider consumption.
The engine records the submitted generation immediately before provider I/O,
after preparation. A crash in that narrow committed interval remains uncertain.
Exits only expire submissions belonging to that generation. Proven-unsent input
returns to the queue after Stop or a restart. Acknowledged input is annotated
through its run ownership when Stop interrupts it.

Echo matching uses shared adapter serialization, delivery generation and native
aliases. Removal retires matching rows and aliases. Thread deletion cleans up the
journal. ACP streamed echoes retain the outgoing prompt's identity and original
parts. Deltas and assistant frames bypass journal lookups.

Native interaction identity and terminal state are persisted independently of
translator lifetimes. Resolved/expired native item identities cannot reopen an
interaction. Pending process-bound interactions expire with
`provider_disconnected`; stale answers receive `interaction_expired` or
`interaction_unavailable`. A genuinely ambiguous answer to a live request keeps
its first-answer reservation. Opening history reconciles completed tools without
reopening them. Automatic restart input is `continue`, with restart provenance
and no warning notice. Existing verbose continuation records are normalized when
sent. WP4 owns classification of new versus historical Codex requests.

`queue.resend` compares a revision, retires an uncertain copy, and creates its
replacement under the recovery command ID in one transaction. It releases only
an uncertainty hold with no remaining ambiguity, quota or continuation. Manual,
Stop and recovery holds remain. Removing the final ambiguous copy exposes an
explicit Resume pause. Clients must explain duplicate execution before resend.

Title regeneration seeks the oldest person input through a SQLite predicate
index and hydrates one bounded page. Worktree Git execution is injected at the
engine boundary. The merge-only `apps/daemon/bench/ux-inputs.ts` reports title and
admission/echo p50/p95 latency and RSS for 0, 1,000, 10,000 and 50,000 historical
items. No benchmark numbers are claimed in this round: the owner prohibits
execution outside the merge gate. Measurements need run at merge.

## Delegation merge

The same input journal also accepts native message identities reported at the
provider boundary. Native identities select a durable host command; adapter origin
metadata and copied wake text cannot change its admitted `MessageOrigin`. Identity
correlation survives replay across provider generations. Existing delegation
identity records migrate into this journal. Delegation summaries remain separate
data: wakes with `subagent_result` origin fold into their `delegation.settled` item
instead of adding a user message. Ordinary person inputs retain their admitted ID.

Provider failures pass through one daemon normalizer. Known native codes produce
readable text, notice/error `code`, `title` and `detail`, and provider `details`;
raw evidence and unknown codes remain available. Assistant prose is unchanged.

## Client pending sends

ADR 0066 owns the client half of admission. A client shows a send at once under
`input:<commandId>`, and a create keeps its `pending:<commandId>` route after the
receipt; the admitted item then takes over that row. A refusal, or a
delivery-failure notice whose `commandId` names the send and whose code is not
`delivery_uncertain`, leaves the input known-not-sent: the client keeps it as a
failed draft the person can edit or send again under a new command ID.

A `delivery_uncertain` notice is not a failed draft. The input may have run, so
the client offers no plain resend for it; recovery goes through `queue.resend`
as above, after the client explains possible duplicate execution.

## Amendment 2026-10-17: a message joins the transcript where it is delivered

Issue #895: a finished reply showed above the three prompts it answered. Every send was
written to the transcript when the daemon accepted it, so a message queued behind a
running turn took its creation place in the middle of that turn, and the running turn's
ID as its run. It moved to its real run only if a later run start guessed it (the oldest
awaiting send, at most one per run), and the web client reordered asks at render time to
hide the difference. The guess missed sends the provider took together and could pick up
continuation runs.

Accepting a send now only names the thread and records its origin in the input journal.
Its `input:<commandId>` item is created in the transaction that takes it out of the queue
for delivery, so its place in the thread (its creation sequence) is where it was delivered.
A queued message waits in the queue, outside the transcript, until then. A steer belongs to
the run it steers into, bound at that moment. Any other delivery has no run until a root run
starts in the session it was handed to: that run takes every input the session was given that
no run has taken yet, one or several the provider took as one turn. A message that returns to
the queue keeps the item and place of its first delivery attempt and is bound afresh when it is
delivered again; a queue edit updates such an item, and is otherwise only a queue change.

### A steer that lands as its turn ends

A steer is bound to the turn running when the engine sends it, but the provider can finish
that turn first and run the steer as a new one. ace does not guess this. It acts only when
the provider says which run took the input, through one of two kinds of evidence:

- **`input.consumed`**: an adapter fact naming the native ids of inputs the provider took into
  the agent's running turn, or with no turn running, into its next one.
- **An echo**: the provider's own copy of the user message, correlated to `input:<commandId>`
  by its native id or by the journal's text signature. An echo arrives inside the run that
  took the input.

Either one binds the input to that run (or, between turns, to the next run that starts). This
only applies to inputs this session was actually handed, and never while history is replayed.
Each provider's evidence:

| Provider | Evidence                                                                                                                                                                                                               | Primary source                                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Claude   | `input.consumed` from `user_message_uuids` on main-thread `assistant`/`stream_event` reply frames. This is every client uuid the turn has consumed, including merged batches and steers folded in between tool rounds. | SDK 0.3.288 `sdk.d.ts` (`SDKAssistantMessage`, `SDKPartialAssistantMessage`); recorded in the 2.1.286 `native-ace-mcp` fixture |
| Codex    | An echo: the turn's `userMessage` item carries `clientId` = the send's `clientUserMessageId`. A `turn/steer` refused with "no active turn to steer" is re-sent to the replacement turn or started as a new turn.       | Codex app-server schema (`ThreadItem.userMessage.clientId`, `TurnSteerParams`); `session-commands.ts`                          |
| OpenCode | `input.consumed` from `session.inbox.delivered {inboxID}`. `inboxID` is the prompt's message id. It is delivered into the running execution, or starts the next one.                                                   | OpenCode v2 inbox events (opencode-v2 research)                                                                                |
| Cursor   | An echo with `nativeId` = command id. A steer into an active SDK operation is a new segment of the same ace run. With no operation active it starts a new run, and the echo follows that run's start.                  | `adapter-cursor` session/translator                                                                                            |
| Pi       | An echo: `message_end` for the user message inside the agent run that injected it, correlated by text.                                                                                                                 | Pi RPC `steer`/`followUp` semantics (pi research)                                                                              |
| ACP      | None needed: ACP adapters do not steer, so steers enter the ordered queue.                                                                                                                                             | `adapter-acp` capabilities                                                                                                     |

If an input moves off a run that has finished, it was never that run's input. Its item is
deleted and created again at the moment it was consumed, with that moment as its `createdAt`,
so it reads after the finished turn and before the answer of the run that took it. The
alternative was to create a steer's item only once the provider confirms consumption. That
would leave the bubble missing for as long as a long tool call runs, and forever if a
producer omits the evidence (older Claude CLIs have no `user_message_uuids`). Recreating the
item happens once and is visible, but it never loses the message. An input that was unbound
when its evidence arrives is bound in place, because its position is already its delivery
point.

Without evidence, a steer stays bound to the run it was sent into. That run is the one the
engine delivered it to, and with these providers the race is rare. A wrong but stable binding
is safer than a guess that could move a correctly placed message.

Clients order the transcript purely by daemon creation sequence. The web client's render-time
`executionOrder` reordering is removed. A client's own unadmitted send still shows as its
pending bubble until the item arrives.
