# 0194: `@` a Spade bot, a club or another agent from an ace thread

Status: accepted. Date: 2026-11-19. Decided by: the owner (2026-11-19: `@` mentions of Spade
bots, clubs and agents in ace project and chat threads, with a visible line saying what is
shared, bot replies labelled in the thread, a link back on the Spade side, messages to agents
through cross-thread messaging, and real pictures in every `@` menu and chip). Builds on
[ADR 0069](0069-extension-catalog-and-mentions.md) (structured mentions),
[ADR 0099](0099-chats-without-a-project.md) (chats), [ADR 0126](0126-spade-agents.md) and
[ADR 0127](0127-spade-main-bot-and-chat.md) (bots and trust), [ADR 0132](0132-spade-teams.md)
(clubs, asks with keys, untrusted context) and the cross-thread messages of issue #2019.

## Context

A person working in an ace thread often wants a second opinion or a hand from somewhere else:
the Research bot that knows their sources, the Launch club, or the agent in the next thread that
is fixing the login page. Today they copy the question into Spade or into the other thread, and
copy the answer back. Neither side knows the other was involved.

Spade can already take an ask with a key and give its answer back by that key (the inbox,
ADR 0132), but only from another machine's daemon. Agents can already message each other's
threads (`agent_message`), but the person can't, from where they are. And the `@` menu shows the
same grey glyph for a TypeScript file, a PDF, a Linear tool and a Claude subagent.

## Options considered

- **Paste the bot's answer into the agent's input.** The agent sees everything, but the person
  loses who said what, and another bot's words would reach a coding agent as if the person
  wrote them.
- **A new transcript item type for a bot's reply.** The honest shape, but every client older
  than the daemon refuses a frame it can't decode and drops the connection (`wire-codec.ts`), so
  an iPhone a version behind would lose every thread that ever had a bot in it.
- **Chosen:** a message the person addresses is stored as their ordinary message with an
  optional `addressed` list, and each reply as an ordinary message with an optional `speaker`.
  Older clients drop the fields they don't know and show plain text, never an error.

## Decision

### Who can be addressed

1. **`@` in a project or chat thread lists, besides files, tabs and threads:** the bots and
   clubs of this machine's Spade (while Spade is on), and **Agents**: the project's other threads
   whose agent is working or waiting. Picking one leaves a chip, as a file does. A message may
   address up to 8 of them.

2. **An addressed message goes to them, not to this thread's agent.** As `@Name` in a club goes
   straight to that member (ADR 0132 decision 2), a message with any addressee is the person's
   message to them. This thread's agent gets no turn; the person sends it a message as usual
   when they want it. The words are stored as typed, with each `@Name` where it was written.

### What is shared, said where it is decided

3. **One visible line says what goes with the message,** under the input while it is being
   written and under the bubble once sent: "Research will see this message and a summary of
   this thread", with "Share only this message" beside it; sent, "Shared with Research: this
   message and a summary of this thread". The summary is the one an `@thread` reference sends
   (`ResolvedThreadReference`, at most 4 KiB): the thread's title and its recent words. Never
   files, attachments, tool output beyond that summary, or the project's contents.

4. **Trust holds.** The person's words reach a bot as the person's own. A shared summary carries
   agents' words and tool results, so it arrives as untrusted context and makes that turn
   untrusted, as a club's earlier bot messages do (ADR 0132 decision 6): every write in it asks
   the person, in that bot's own chat. With "Share only this message" the turn is the person's
   own.

### Delivery, exactly once

5. **The daemon asks Spade, by key.** For each bot or club it makes a key from the thread, the
   message and the addressee, stores the ask before sending, and sends
   `POST /v1/thread-asks {key, to, text, context?, thread}` to its own Spade. Spade stores the
   key in the same transaction as the message it delivers, so a retry after a crash on either
   side never delivers twice. The daemon reads the answer back with a long poll
   (`GET /v1/thread-asks/{key}?wait_ms=`). After a restart it reads every ask still open again.
   If Spade is off the ask waits and the line says so; it gives up after 7 days.

6. **Only the daemon labels an ask as a thread's.** `spade.http` and the desktop's direct path
   refuse `/v1/thread-asks`, as they refuse the inbox. A client can still write to a bot as the
   person; it can't make a message claim to come from a thread it didn't come from.

### Replies, and what they are not

7. **Each reply is posted in the thread under its bot's face and name.** A club's replies come
   one per member that answered, each with that member's face, "in Launch". While a bot works,
   the line under the person's bubble reads "Research is answering"; while it waits for the
   person, "Research is waiting for you" with "Open in Spade". A failure or a stop says so in
   the same line.

8. **A reply is never the agent's.** It doesn't count as the agent's answer, a delegated
   thread's result, input to the title, or anything a provider receives. Each open ask holds
   the thread open as one of ace's background tasks (`ace-ask:<key>`), so the thread never reads
   as done while a bot is still answering. Stop in the thread stops its open asks.

### Back on the Spade side

9. **The ask shows where it came from.** Spade stores the thread with the message
   (`from_thread {id, title}`). In the bot's chat, and in a club, the person's bubble carries a
   quiet line "From ace · Fix login" that opens that thread in ace.

### Agents

10. **`@` an agent sends the person's message to that thread** through ace's cross-thread
    messages: as the person's own words there (origin `person`, `via` this thread) with a
    reference to this thread, steering a running turn or starting the next. That thread shows
    "You, from ‹this thread›" above it, linking back; this thread shows "Sent to ‹that thread›".

### Pictures

11. **Every reference shows what it is,** in the menus and in its chip, by one rule shared by
    the clients (`@ace/ui-core` `mention-marks.ts`): a file its kind's glyph in its ink, a folder
    a folder; a bot its face, a club its members' faces stacked; an agent, a thread or a
    provider's own agent its provider's mark; an app, an app's tool or a plugin named for one
    the brand mark from `app-art`, matched by name, else its kind's glyph (never a guessed
    letter).

## Consequences

- New optional fields: `addressed` and `speaker` on message items, `via` on `MessageOrigin`;
  a new `thread.address` command. An older daemon refuses the command with its usual unknown
  command error. The web app is served by its daemon, so the two match.
- Spade gains `from_thread` on user messages and club messages, and `/v1/thread-asks`; its
  stored events stay readable by older builds (the field is optional).

## Limits

- Bots and clubs of other machines are not listed yet; ADR 0132's machine call can carry
  them later.
- A thread's first message (New thread, New chat) always goes to its agent: there is nothing to
  share from yet.
- A bot waiting for the person shows in the thread's line and in Spade's own badge, not in
  ace's Inbox.
- iPhone shows the replies as plain assistant text until it reads the new fields.
