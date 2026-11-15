# 0156: A request too large to send whole goes as a summary that says so

Date: 2026-11-15. Status: proposed. Amends [ADR 0006](0006-large-payloads.md), decision 3: a
snapshot still carries every pending request, but one too large goes summarized.

## Context

A thread snapshot carries every pending interaction whole (`EntityWindow.fill`). Nothing in the
interaction schema bounds a description, a plan, a question set, an elicitation schema or a tool's
input; only `target.command` is capped (32 KiB). When a snapshot's text is over the outbox's
stream budget (64 MiB as UTF-16, `outbox.ts`), the daemon resyncs the connection (close 4009). The
client reconnects, subscribes again, gets the same snapshot and never opens the thread (#2099).
Two shapes reach it: 100 pending approvals with 400 KiB descriptions, or one with a 33 Mi-character
description. A live `interaction.opened` over 1 MiB resyncs the connection the same way.

Cutting the request to fit is not an answer on its own: a plan cut to its first 2 KiB still
offered "Approve plan", and a file edit's input or a browser script can be cut.

## Options considered

- **Raise the budgets.** Moves the limit, never removes it, and puts megabytes on phones.
- **Name large requests only (`tooLarge`, as entity pages do since #2093).** The phone can then
  only say "open on a computer", and the computer has nowhere to open it.
- **Cut silently.** Rejected above: the person approves what they were not shown.
- **Store a summary in place of the request at write time** (as ADR 0006 does for raw payloads).
  The provider adapters and the engine need the whole request, and a summary in the log can't be
  undone; summarizing on the way out keeps storage whole.
- **Chosen: summarize on the way out, flag it, read the whole on demand, and refuse an
  affirmative answer until it was shown.**

## Decision

1. **A request whose JSON is over 64 Ki UTF-16 code units goes to clients as a summary.** It is
   the same `Interaction` with its request reduced, `raw` empty and `truncated: { chars }` set to
   the whole request's length. This holds everywhere a client gets an interaction: snapshots, live
   and replayed events, and entity pages. Storage, the engine and adapters keep it whole. The rule
   is `summarizeInteraction` in `@ace/projection/interaction-summary`.
2. **A summary is bounded and keeps what an answer names.** Each text is cut to a few KiB and ends
   in "…", arrays keep their first entries, and parts with no bound of their own (a tool's input,
   an elicitation's schema, permission updates, a URL too long to keep whole) are left out. Every
   option id goes, and every decline goes even past the option cap, so a person can always say no.
   A summary is under 64 Ki code units however large the request.
3. **`interaction.read` reads the whole request** as pages of its JSON (64 Ki code units each)
   with a `version`; a reader whose pages differ in `version` starts again. A copy that is itself
   a summary (another machine's request mirrored here) can't be read whole.
4. **An affirmative answer needs the person to have been shown the whole request.** Allow,
   approve, accept and answering questions are affirmative; deny, reject, cancel, decline and
   dismiss are not. A client sets `readWhole: true` on `interaction.resolve` only once it showed
   the request whole. The daemon refuses an affirmative answer from a client
   (`request_not_read`) to a request it sends summarized without `readWhole`, and always to a
   mirrored summary. Clients older than this decision get summaries with the flag stripped and
   their affirmative answers refused, never applied.

## Consequences

- A thread with any number of large pending requests opens, within budget, on every client.
- The web reads a summarized request whole when it is shown and offers its affirmative options
  once it has. The phone shows the summary, says it is too large to review there, and offers
  only declines.
- A request from another machine that is too large can only be declined through this daemon; to
  approve it, connect to that machine.
- A snapshot's active requests are still bounded only by their count: about 500 requests just
  under the bound would reach the stream budget. Accepted; no such thread is known.

## Tests

- `packages/projection/src/interaction-summary.test.ts`: summaries are bounded and flagged for
  every kind, keep every decline, and which answers need the whole request.
- `apps/daemon/src/pending-pages.process.test.ts`: the #2099 reproductions open, live events and
  entity pages carry summaries, `interaction.read` returns the whole request under one version
  (a new one once it is replaced), and an affirmative answer without `readWhole` is refused.
- `apps/daemon/src/interaction-reads.test.ts`: pages never split a character, a mirrored summary
  can't be read whole.
