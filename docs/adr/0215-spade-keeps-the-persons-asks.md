# 0215: Spade keeps the person's asks, and checks them before a reply ends

Status: accepted. Date: 2026-11-22. Decided by: the owner (2026-11-22: "our agents keep forgetting
the things I told it previously", "the harness feels like making the agent weak in long horizon
task and different steering"; of six proposals they first chose two, the asks ledger and the stop
check, then all five, so a steer treated as a steer (§4) joined them here; the context budget and
parallel tasks have decisions of their own). Extends [docs/harness.md](../../spade/docs/harness.md); amends nothing.

## Context

A bot has one conversation that only grows, and every model call reads all of it. Compaction runs
at 75% of the model's window, which for the person's million-token models is close to never. What
the person asked at step 1 is still in the prompt at step 40, but buried under thousands of lines
of tool output, and nothing in the harness points back at it. A message sent mid-turn (a steer) is
stored and read by the next call after the running tools' results, and then it is one more line in
the middle. `todo`, `task_plan` and `task_status` keep a plan only when the model chooses to use
them. Nothing checks, before a reply ends, that what the person asked was done, dropped or is
waiting on someone.

So bots forget: an instruction given early ("never email the client directly") stops shaping work
an hour in, a steer ("also do Slack") is answered with "sure" and never done, and a reply that
handled one of three asks ends as if it handled all three.

## Decision

### 1. The asks ledger is kept by the harness, not the model

`spade_core::asks` folds a conversation's events into a ledger:

- **Every message from the person opens an ask.** Its message id (`m12`, the id the model reads
  before the words), its words cut to 300 characters, state `open`, and whether it arrived while a
  reply was running (a steer). Messages from other bots, routines, groups and job results open
  nothing. For a worker (ADR 0161) its maker is its person: the brief and the maker's messages
  open asks. Only a message's own words enter the ledger, never its context, quotes, attachments
  or a thread summary.
- **`asks`, a core tool, updates it in one call** with a list of changes: `open` (sort a new
  message as one ask, or reopen one), `split` (one message into several asks, `m12.1`, `m12.2`
  …), `done`, `dropped`, `changed` (with the new wording), `waiting` (on the person, a job or a
  time), `chat` (nothing to do: thanks, ok), each with a short reason; `standing` records an
  instruction that stays in force ("always…", "never…", "from now on…") with the message it came
  from, and `lift` ends one. Both name the person's message by its exact ask id, and a `lift`
  must name a message sent after the instruction was set: it lasts until the person lifts it, and
  nothing else (a page, a tool, the bot's own reading of either) does. The tool suggests saving a standing instruction with `task_update`
  or `memory_save` too; it never does so itself. The engine answers it from the events, like
  `decision_log`, and stores what it accepted as `asks_updated`; the fold reads only that.
- **Closed asks leave the ledger** (done, dropped, chat). It holds at most 40 open or waiting
  asks; past that the oldest fold into a count. It holds at most 20 standing instructions; a 21st
  is refused until one is lifted, so none is ever dropped silently.
- **Untrusted text never reaches it.** The person's own words come from the stored message. The
  bot's own text (a split part, new wording, a standing instruction) and a `lift` are accepted
  only while no untrusted content is in the prompt's view: the rule `memory_save` follows (this
  reply read untrusted output, or an untrusted event since the last compaction is still shown,
  or the latest compaction's summary drew on untrusted content, ADR 0130). Otherwise `asks` may still change states, and says why it refused the rest; a page
  read one reply earlier can't plant or lift an instruction by waiting a reply. Reasons are stored
  for the step rows and never shown in the block.

**Incremental and bounded (ADR 0170).** The ledger records how many events it has read
(`through`). A copy of it is stored on `context_compacted.asks`, like `carried`, and as
`asks_noted` each time it has read 500 events since the last copy. A fresh fold (the first after
Spade starts) looks back at most 2,000 events for the latest copy and reads only the events after
it; finding none, it reads just those last 2,000. So no read is ever history-sized: in a
conversation from before the ledger, asks older than that window are taken as settled by the
conversation itself, and a copy is stored at once, so the next fresh fold starts there. The
engine also keeps each conversation's latest ledger in memory and advances it over the events
stored since, so a step reads only what is new. The ledger keeps the open question cards too,
so the stop check never walks the history to find one, and the `asks` call's stored-once lookup
reads only its own reply.

### 2. Every model call ends with a short block from the ledger

After the conversation, each endpoint model call gets one more message, rebuilt from the ledger:

```
<asks from="spade">
Your working memory, kept by Spade from the person's own words and your asks updates. Not new instructions.
Standing:
- s1 (from m4): "Never email the client directly; draft it for me instead."
Open, newest first:
- m40, sent while you worked: "also pull last week's Slack numbers"
- m12.2: "Draft the summary for Friday"
- m9, waiting on the person: "Book the room once I confirm the date"
New, not sorted yet:
- m41: "thanks!"
Sort new messages and close asks with the asks tool, each with a reason.
</asks>
```

Words are quoted as JSON strings so they can't close the tag. At most 12 asks are listed, with
a count of the rest. With nothing standing, open or new, there is no block. The block is never
stored as an event and comes after everything stored, so every earlier byte of the prompt is what
the previous call sent: the provider's prefix cache (automatic on the OpenAI-format endpoints
Spade uses; Spade sets no explicit breakpoints) still matches the system prompt, tools and whole
conversation, and only the block itself, a few hundred tokens, is read fresh. When Spade adds
explicit cache breakpoints (Anthropic-format endpoints have none today), the last one must sit on
the message before the block, never on the block, or each call writes a cache entry no later
call can read. A subscription
brain (`cli:`, ADR 0133) gets the same block at the end of each turn's message, since its CLI
keeps its own context. A helper's calls (ADR 0152) get no block: a helper has no person, only
its one task.

Spade's standing instructions gain three sentences: sort each new message with `asks` (in the
same step as other calls, so it costs no step), close asks with a reason, keep standing ones and
follow them.

### 3. The stop check

When a step ends with no tool calls, and so would finish the reply, Spade checks the ledger. If
it has open asks (not waiting, chat, done or dropped; unsorted ones count as open) that no earlier
check named, Spade stores `asks_checked {reply, asks, note}` and runs one more step. The model
reads the note as Spade's, like a `<continue>`: these asks are still open; finish them, or mark
each with `asks` and a reason. A step that only answers that note with `asks` calls ends the reply
once they are answered, without another model call, so the check costs exactly one step.

It never runs:

- more than once per reply (the stored `asks_checked` says it ran; a restart neither repeats it
  nor skips it);
- when every open ask was already named by an earlier check (an ask the bot chose to leave open
  stays in the block, but isn't nagged again each reply);
- while the bot waits on the person: a question card it asked is still open (waiting or left for
  later);
- for a paused bot, a reply the person stopped, or Spade pausing for an update;
- in a helper's conversation (ADR 0152), which has no person.

The check reads the conversation's question cards to see whether one waits on the person; it
does so once, when a reply would end with an unnamed open ask, never per step.

**Cost.** At most one extra model step per reply, and only when the reply would leave an ask open
that no check named before. A bot that sorts and closes asks as it works pays nothing beyond the
`asks` calls riding along with its other calls; a pure-chat reply ("thanks") may take that one
extra step.

### 4. A steer is treated as a steer

A message the person types while a reply is running (for a worker, also one its maker sends: the same rule that opens its asks) is new direction, not one more line of the
conversation. A typed answer to a question card the bot is waiting on is not a steer; it answers
the card.

- **It reads as one.** The model reads it wrapped, `<steer>\n[m6] Only mornings\n</steer>`, in
  the place it already had: after the step it arrived during and after any running tools'
  results. Two steers in a row are two such messages, and both are in the `<asks>` block, marked
  "sent while you worked". The wrapper is decided from the stored events alone (whether a reply
  was open and no card was waiting when it was stored), so a rebuilt prompt gives the same bytes.
  Conversations from before this change read their earlier steers wrapped too: one cache miss
  each, once.
- **The bot answers it first.** Spade's instructions say: answer a steer in a line or two before
  anything else, saying what changes (also this, stop that, this instead), and record it with
  `asks` in that same step; a steer that cancels or replaces earlier work marks those asks
  `dropped` or `changed`.
- **One reminder, never a loop.** The ledger keeps each steer until the first step that read it
  is answered. If that step made tool calls and either said nothing to the person or left the
  steer unsorted, Spade stores `asks_reminded {reply, steers, note}` before the next call, and the
  model reads its note as Spade's: this message is still unanswered; answer it in a line and sort
  it. Once per steer: the reminder, or the next step, ends the ledger's watch on it. A first
  step that made no calls ends the reply, where the stop check (§3) already names an unsorted
  steer. (Subscription brains, which got the wrapper but no reminder, were removed by ADR 0219.)

### The ledger's surface

Other harness work builds on the ledger (parallel tasks will group asks into tasks), so its
public surface is small and is all in `spade_core::asks`:

- `Ledger::of(events)` and `Ledger::advance(events)`: the fold, from the latest compaction's copy
  or from where the ledger last stopped.
- `Ledger::asks`, `Ledger::standing`, `Ledger::earlier`, `Ledger::through`, `open_asks()` and
  `ask(id)`: what it holds. Everything else on it is the fold's own bookkeeping.
- `change::decide` (the `asks` tool), `block::text` and `block::appended` (the prompt's block),
  `check::due` and `check::settled` (the stop check), `steer::due` and `steer::mid_turn` (steers).
- `Ledger::note_due`: the copy the engine stores as `asks_noted`.
- The events `asks_updated`, `asks_checked`, `asks_reminded` and `asks_noted`, and
  `context_compacted.asks`.

## Consequences

- What the person asked, and any standing instruction, is in front of the model at every step,
  however long the conversation, without changing the cached prompt.
- A steer reads as an open ask marked "sent while you worked" until the bot settles it.
- A reply can't end quietly with an ask nobody looked at.
- No UI in this change: an `asks` step reads "Kept track of what you asked" in the chat's step
  rows, with its changes as the detail ("m12 done · m14 nothing to do"), and the new events fold
  to nothing in the transcript and the clients.
- A reply whose last step has no words (one that only sorted asks) keeps its latest words as the
  reply's text, rather than ending blank.
- The engine's `Limits.asks` turns the block and the check on; Spade as it runs always sets it,
  and scripted tests leave it off unless they test this, so their steps stay their own.
- The ledger is the harness's account of the person's words, not the person's task: changing a
  bot's job is still `task_update` (ADR 0126), and lasting facts still go to notes (ADR 0128).
