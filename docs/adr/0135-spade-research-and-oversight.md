# 0135: Spade researches in depth, and the person oversees each bot's spending and actions

Status: accepted. Date: 2026-11-12. Decided by: the owner (2026-11-12: make Spade complete and
better than the best persistent-agent products; build deep research, per-bot spending caps, an
activity log and an optional model review end to end). Builds on
[ADR 0119](0119-spade-endpoint-keys.md), [ADR 0126](0126-spade-agents.md),
[ADR 0127](0127-spade-main-bot-and-chat.md) (the chat shows only the current status, never tool
calls), [ADR 0129](0129-spade-routines.md) and [ADR 0130](0130-spade-skills-and-workspace.md)
(each bot's workspace and the trust rules for files). The contract is in
[spade/docs/oversight.md](../../spade/docs/oversight.md).

## Context

Spade's bots work on their own: routines wake them, they message each other, they run commands in
their workspace and call the person's apps. The chat deliberately shows none of that (ADR 0127).
Three gaps follow from working autonomously:

- A question that needs many sources is answered with a few `web_search` and `web_fetch` calls in
  the turn itself, which fills the bot's context with pages and stops at whatever the model
  happened to read.
- Spending has one cap for the whole service, per machine day. One busy bot can use the day's
  budget for every other bot, and nothing bounds a month.
- When the person wants to know what a bot did, the only record is the raw event log. And the
  approval gate decides from fixed rules (risk, "always", taint): a write the person allowed
  "always" runs even when the bot's reason for it looks wrong.

## Decision

1. **Deep research is a background tool.** `research {question, depth}` runs as a job (ADR 0126's
   background tools), so the bot's turn carries on and its context never holds the pages. It
   plans a handful of sub-questions with search queries, runs the searches and reads the pages in
   parallel within budgets of time, pages and spend (`quick`, `standard`, `deep`; each also stops
   at the bot's and the service's caps), picks from each page the passages that bear on the
   questions, and has the model write a report that cites sources by number, says where sources
   disagree and which claims rest on one source only, then checks every cited claim against the
   passages. The sources list is built by Spade, not the model, so every number points at a page
   it read. The report is written to `research/` in the bot's workspace and never recorded as a
   trusted file; the bot gets a summary, the path and the count of sources. The result counts as
   untrusted, so a write after it asks. While it runs, the status line says
   `Researching · 14 sources read`; nothing else shows. Research reads only; it asks nothing.

2. **Each bot has optional daily and monthly caps**, in millionths of a US dollar like the ledger,
   beside the service's daily cap. Days and months are the person's, in the time zone the app
   sends (the machine's until it does). A bot at a cap starts no model call: its turn ends, it
   says so once per day or month as one bubble in its chat, the person's messages to it are
   refused with the reason, other bots' messages to it come back as an error, and its routines are
   skipped. Research and the model review stop at its caps too. Spend per bot, today and this
   month, shows in the roster, in the bot's edit form and in Settings › Spade.

3. **Each bot has an activity log**, reached from the bot's menu (Activity), never from the chat.
   It is folded from the conversation's stored events, so it costs no new writes and can never
   disagree with them: tool calls with their arguments cut short, approvals asked and answered,
   routines fired, messages to and from other bots, connector calls, files written, review
   verdicts and the cost of each turn. It is newest first, searchable, and filtered by kind and by
   the person's day. Secrets never show: values under names such as `token`, `password`, `key` or
   `authorization`, and strings shaped like keys or bearer tokens, are replaced before they leave
   Spade.

4. **An optional model review checks writes before they run.** It is off by default; the person
   turns it on for every bot (Settings › Spade) or for one bot (its edit form), and picks the
   review model (the fast model when none). When the rule gate would run a write without asking,
   the review model judges the call against the bot's task, the person's recent words and the
   untrusted sources in view, and either allows it or escalates it to the person, its reason shown
   in the approval bubble. It only ever adds a question: a call the gate asks about is asked about
   without a review, and a review that fails, times out or finds the bot at its cap escalates.
   Each verdict is stored in the conversation and shows in the activity log. With the review off,
   no extra model call is made.

## Options considered

- **Research as a sub-agent with its own conversation.** Reuses the loop, but each step's prompt
  would carry every page read so far and its spend would be hard to bound; a pipeline with fixed
  phases is cheaper and its budgets are exact.
- **Caps in the app.** The app is not always open; the caps must hold where the calls are made.
- **An activity table written beside the events.** Two records that can disagree; folding the
  events already stored is enough at the size of one bot's history.
- **A review that can also approve.** Would let a second model overrule the person's rules; the
  review is only ever stricter.

## Consequences

- A report costs a few model calls (plan, write, check) plus reading time; `quick` is a few cents
  on a fast model.
- People see what each bot did and what it cost without the chat showing any of it.
- With the review on, each write the gate would have run costs one extra model call and adds a
  moment before it runs.
- Caps are checked before each model call; a call already running finishes, so a cap can be
  passed by at most one call's cost.

## Tests

- Research stays within its page, time and spend budgets, writes a report whose numbered sources
  are the pages it read, and its result taints the turn.
- A bot's daily and monthly caps stop new model calls, the bubble comes once, and the day resets
  at the person's midnight, not the machine's.
- The activity log has an entry of each kind and never shows a secret.
- The review escalates a write it judges wrong, can never let through a call the gate asks about,
  and makes no model call when off.
- The app lists a bot's activity with filters and search, and saves its spending caps.
