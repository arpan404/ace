# 0132: Spade's bots work together: groups, bots on other machines, templates

Status: accepted. Date: 2026-11-12. Decided by: the owner (2026-11-12: make Spade complete, with
bots that work together: group chats with a lead, bots reaching bots on the person's other
machines through ace, and bots made from templates, duplicated, exported and imported). Builds on
[ADR 0126](0126-spade-agents.md), [ADR 0127](0127-spade-main-bot-and-chat.md),
[ADR 0129](0129-spade-routines.md) and [ADR 0131](0131-spade-connectors.md); the machine paths
it uses are [ADR 0078](0078-multi-device-mcp.md) and
[ADR 0105](0105-linked-machine-capabilities.md).

## Context

A Spade bot is one long conversation with one job. Bots on one machine can already ask each other
(`bot_message`, ADR 0127), but only one at a time, only on the same machine, and the person sees
none of it. Real work often needs several bots at once: a research bot finds sources, a writing
bot drafts, Spade puts it together. The person wants to watch that happen in one place and steer
it, as they would a group chat with people.

Bots also run on several of the person's machines (ADR 0127 decision 2). Reaching a bot on
another machine was left for later. ace already links the person's machines: each daemon reaches
the others as a paired device over pinned TLS (ADR 0078), and each machine decides what callers
from the others may do (ADR 0105).

Making a bot means writing its task from nothing. Most people want the same few kinds of bot,
and want to copy a bot that works, or move it to another machine.

## Options considered

- **Groups as a separate engine where bots talk freely.** Each bot answers every message it
  sees. Lively, but loops without end, spends without bound, and nobody is in charge.
- **Groups where each member runs in a fresh conversation per group.** Keeps a bot's own chat
  clean, but splits what the bot knows across conversations and breaks "one bot, one
  conversation" (ADR 0126).
- **Chosen:** a group is its own shared transcript. Each member answers in its own one
  conversation, as it answers a `bot_message`, and its answer is posted in the group as its
  message. A lead decides who answers. Every hop goes through one place that counts and stops.
- **Cross-machine through a new peer channel between Spades.** A second trust channel to secure.
  **Chosen instead:** Spade asks its own daemon, which uses ace's existing paired-machine call.

## Decision

### Groups

1. **A group is a name, a lead and 2 to 8 member bots, with its own transcript.** Members may be
   on any of the person's machines. The lead is a member on the group's machine: Spade by
   default, or the bot the person picks. The group lives on the lead's machine. The person,
   members and lead can change; the transcript stays.

2. **The person posts; the lead decides.** A message with no mention goes to the lead. The lead
   answers it in its own conversation, as it answers any message, with its own model, memory,
   tools and connectors, and its reply is posted in the group as its message. To hand part of the
   work to a member it calls `group_ask {member, text}`; the member answers in its own
   conversation and that answer is posted in the group as the member's message, then returned to
   the lead, which can carry on. A member answering a group ask may ask another member the same
   way. `@Name` in the person's message sends it straight to that member (several mentions, to
   each), bypassing the lead.

3. **What the group shows.** The person's messages and each bot's messages are bubbles with that
   bot's face and name. A handoff is one short line (`Spade asked Research`), never a tool call.
   While members work, one line names who is answering (`Research is answering`); a member
   waiting on the person says so (`Research is waiting for you`), with a text button that opens
   that bot's own chat, where the approval or question is.

4. **No runaway loops.** Each message from the person starts a run. A run allows at most 8
   asks, the person's own included, and a chain at most 3 deep (person to lead, lead to member,
   member to member). An ask beyond either is refused with words telling the bot to answer with
   what it has. Bots never post in a group on their own: a bot's message appears only as the
   answer to an ask. Routines and heartbeats never post in a group.

5. **Stop stops the whole group.** Stop in a group ends the current run: every ask still open
   is stopped, on every machine, and a stopped member's partial answer is not posted. Asks made
   after Stop are refused.

6. **Trust holds.** A member asked by another bot reads that ask as another bot's message, so
   every write in that turn asks the person (ADR 0127). A message the person posts reaches the
   lead as the person's own words; the group's earlier messages from other bots that come with
   it are untrusted, and so is the turn they arrive in. Approvals stay in each bot's own chat.

### Bots on other machines

7. **Spade reaches another machine through its own daemon.** `bots_list` lists the bots of every
   linked machine whose Spade answers, with the machine's name; `bot_message` and groups reach
   them. Spade asks its local daemon (over the socket it already uses, with ace's local
   credentials) to forward one request to a named machine. The daemon sends it as one new
   machine-call op, `spade`, to that machine's daemon, which forwards it to its own Spade's
   loopback API. Nothing else is added to ace.

8. **Only the person's own machines.** The target daemon takes the call only from a paired or
   account machine of the same person, under its Agents grant (ADR 0105): reading the bot list
   needs Read, delivering or stopping needs Read and act; a guest pairing from a time-limited link
   is refused. It stamps the pairing the call authenticated with and the machine's name, and
   signs the request with its own local token; Spade checks that signature against the token in
   ace's home and refuses anything else, so Spade's bearer token alone never reaches the inbox,
   and the daemon's `spade.http` path refuses the inbox route. Neither the app, a device nor a
   local process holding only Spade's token can pretend to be another machine.

9. **Exactly once.** Each ask carries an idempotency key made by the sending Spade. The sender
   stores the ask in an outbox before sending; the receiver stores the key in the same
   transaction as the message it delivers, so a retry after a lost answer, a crash or a restart
   on either side never delivers twice. The answer is read back by key (a long poll), so no
   path from the target back to the sender is needed.

10. **Offline targets wait.** When the target machine or its Spade can't be reached, the ask
    stays queued and says so (`Waiting for Studio to come online`); it is sent when the machine
    is back, with backoff, for up to 7 days, then given up with a clear reason. Stop withdraws a
    queued ask before it is sent.

### Templates, duplicate, export and import

11. **Templates.** Spade ships a set of bot templates (Inbox, Research, Release notes, Travel,
    Finance, Writing, On-call, Learning, Meeting notes, Health habits), each a name, a task, an
    avatar colour, a suggested kind of model (fast or capable) and suggested routines. "New bot
    from template" fills the creation form; the person can change everything before creating.

12. **Duplicate** makes a new bot on the same machine with the original's task, avatar, model,
    routines (paused when the original's are paused, with new webhook secrets), connector choices
    and notes. Never its conversation.

13. **Export and import.** A bot exports to one JSON file: name, task, avatar, model, routines,
    connector choices by name and notes. Never a key, token, webhook secret or the conversation.
    Importing it on any machine makes a new bot; a model or connector that machine doesn't have
    is left out and the answer says so.

## Consequences

- A group spends only what its run allows; a busy member steered by a group ask answers both in
  one reply.
- A member's own chat shows group asks with a small label (`In Launch team`), so the person can
  see what a bot was asked and why it acted.
- Members on other machines answer, but can't ask other members themselves: a group ask is made
  only on the group's machine.
- A bot on an offline machine still shows in the group as away; its asks wait.
- The daemon learns one machine-call op and two local requests; it passes Spade's bodies through
  without reading them, so Spade owns the inbox schema.

## Tests

- A message with no mention goes to the lead; `@Name` goes to that member; a member's answer is
  posted as its bubble; `group_ask` beyond 8 asks or 3 deep is refused; Stop stops every member's
  turn and later asks are refused.
- Across two Spades and a fake daemon between them: an ask retried after a lost answer and after
  a restart is delivered once; an ask to an offline machine waits, says so, and is delivered when
  it is back; the inbox refuses a request without the daemon's stamp.
- Templates create bots with their routines; Duplicate copies task, avatar, model, routines,
  connector choices and notes and not the conversation; an export has no secrets and importing it
  recreates the bot.
- Web: the roster lists groups with stacked faces; a group shows each bot's bubbles with its face
  and name and handoffs as short lines.
