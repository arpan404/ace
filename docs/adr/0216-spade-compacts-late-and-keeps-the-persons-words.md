# 0216: Spade compacts late and keeps the person's words

Status: accepted. Date: 2026-11-22, revised 2026-11-23. Decided by: the owner (2026-11-22: bots
"keep forgetting the things I told it previously"; 2026-11-23, on a first draft that compacted at
a 128k-token working budget: "we must not have such low context window as the agents nowadays can
handle millions of context easily", then "lets do 90% around"). Amends
[ADR 0158](0158-spade-no-fixed-step-or-time-limits.md) on when compaction runs; its rule that
nothing ends a turn stands.

## Context

Spade compacted once the endpoint's last reported prompt reached 75% of the model's own window
(200,000 tokens for a model that doesn't say; `SPADE_CONTEXT_TOKENS` capped it as a cost choice).
When it did, the summary took the person's own messages along with everything else, so a standing
instruction ("always run the tests first") lived on only if the summary happened to keep it. That
is what the person saw as bots forgetting what they were told.

The size check had gaps too. It used the previous request's reported size, so results that came
back after it didn't count: on a small model, one step's results could push the next request past
the window before any compaction. It looked only at the turn's own model, not the fallbacks that
may serve the step. And a step that reported no size after a compaction fell back to the size from
before it.

A first draft of this decision compacted at a 128,000-token working budget and aged old tool
results by default, citing long-context studies (RULER, NoLiMa, Chroma's "Context Rot") that find
models use a long prompt worse than a short one. The owner rejected both defaults: current models
handle very large windows, and bots should see full output. Both remain available as choices the
person makes.

## Decision

1. **Compact at 90% of the window.** A conversation compacts once its next prompt reaches 90% of
   the smallest context window among the models that may serve the step: its model and that
   model's fallbacks (`compaction::HIGH`, `Budget::trigger`). A compaction keeps recent turns
   worth about 35% of the window (`LOW`). On a 1M-token model that is about 900k before a
   compaction and 350k kept after it.
   - **The next request is estimated, not the last one.** The size is the latest step's reported
     prompt since the last compaction, plus a token per four characters stored after it. With no
     report since the last compaction, it is the shown span's text alone. So results that arrive
     after a report count, and a size from before a compaction never does. The cut is sized
     against the shown span only (the latest summary and the events from its cut).
   - **The person can cap it lower.** `context_tokens` on the existing model-roles settings
     (`PUT /v1/agents/{id}/models`, `PUT /v1/models/roles`) is a lower cap: the bot's, else the
     global one, else none; at least 16,000 tokens. The window stays the ceiling, so a cap above
     90% of it changes nothing. `SPADE_CONTEXT_TOKENS` still caps the window.
   - **A compaction counts once stored.** One that cannot be stored is not reported as done, so
     the turn goes on rather than paying for the same summary again.
2. **Old tool results can age out, off by default.** The owner prefers that models see full tool
   output, so results stay whole unless the person turns on `age_results` (per bot or for every
   bot, on the same model-roles settings; the bot's choice, else the global one, else off). Aging
   is a cost choice: it keeps a long task's prompt small and cheap. When it is on:
   - A tool result shown in a later prompt is replaced by a short stub once aging reaches it: the
     tool, what it was called with (arguments shortened as in the carried-out list), its size,
     and how to get it back (`history_read` at its position, `history_search`, or calling the tool
     again).
   - Never aged: the person's messages, the bot's own words, `ask_user` cards and answers,
     approvals (they are not results), errors, results of 2,000 characters or less, results with
     images, `skill_load` and `tool_search` results, the results of the latest 4 steps and at
     least the latest 8 results. A conversation not offered `history_read` ages nothing.
   - Aging is fixed by a stored event, `results_aged { before }`: every result before that index
     that may age is a stub. The engine stores one before a model call only when the results that
     would age add up to at least 64,000 characters (about 16,000 tokens) (`aging::due`), so the
     prompt changes in batches.
   - History tools (`history_read`, `history_search`) run on the caller's own conversation before
     any bot lookup, so a helper can follow a stub too.
3. **Compaction keeps the person's words.**
   - Only words the person wrote: here or in an ace thread (labelled so), never another bot's, a
     routine's, a group's, or anything in a helper's conversation, whose brief is the bot's.
   - Each compaction stores them from the span it summarises, word for word, on its `carried`
     ledger (`said`, `said_earlier`), carried forward from compaction to compaction like the writes
     already carried out. The stored summary is the model's summary, then "What the person said
     earlier, word for word", then the writes already carried out.
   - Each message is quoted as its own block under `[#position] The person wrote:`, with every line
     starting `> `, so nothing inside one can pass for another or for Spade's own words.
   - A message over 3,000 characters keeps its start and says where the rest is. The list is
     bounded at 24,000 characters: the newest message always stays, then standing instructions
     (messages under 600 characters with "always", "never", "from now on", "don't", "remember" and
     the like), newest first, then the rest, newest first; what doesn't fit is counted and pointed
     at `history_search`.
   - The list is worked out before the summary is asked for, and the request names the messages
     kept only in part and how many are dropped, so their requirements go into the summary. The
     request also asks for every decision and who made it, and for open commitments (what the bot
     said it would do and hasn't), stored as `commitments` and shown as "Commitments still owed".

The new fields are additive and read leniently: a `context_compacted` from an earlier build reads
as before, and a `carried` ledger without `said` carries nothing.

## The prompt cache, when aging is on

A prompt cache matches the request's longest unchanged prefix. Between two `results_aged` events
every prompt is the previous one plus what came after it (tested: requests between batches start
with the previous request's messages), so each step reads the whole earlier prompt from cache. A
batch changes the prompt at its first newly aged result: from there on the request is written to
the cache again, once. Storing a boundary every step would rewrite that suffix every step; the
64,000-character batch makes it rare.

Measured on a scripted task (`spade-core` aging tests' fixture): 120 steps, each reading a
15,000-character page, no compaction, prompt characters counted per request, a message counting as
cached when it and every message before it equal the previous request's.

|               | Batches | Last prompt                | Cached reads, all steps      | Written again, all steps    |
| ------------- | ------- | -------------------------- | ---------------------------- | --------------------------- |
| Without aging | 0       | 1.83M chars (~457k tokens) | 108.7M chars (~27.2M tokens) | 1.83M chars (~457k tokens)  |
| With aging    | 22      | 0.21M chars (~52k tokens)  | 16.4M chars (~4.1M tokens)   | 4.22M chars (~1.06M tokens) |

Aging writes about 2.3 times as much to the cache (each batch rewrites about 27k tokens) and reads
about 6.6 times less. Priced as Anthropic prices caching (reads 0.1, writes 1.25 of an input
token), the task costs about 47% less input; priced as most OpenAI-compatible endpoints do (reads
about 0.25, no write premium), about 70% less. That saving is why it stays available; it is off
because the owner prefers the model to keep the full output.

## Consequences

- By default a bot on a 1M-token model carries up to about 900k tokens before it compacts, and
  reads every tool result whole. A person who wants smaller or cheaper prompts sets
  `context_tokens`, turns on `age_results`, or both, per bot or for every bot.
- When a compaction does run, the person's own words survive it word for word, and what is cut of
  them is named to the summary.
- With aging on, a bot rereads an old result when it needs it; the stub tells it how. Tools whose
  results it must keep following (skills) never age.
- The prompt changes at three kinds of point, all stored: a compaction, a new skill/notes index
  after one, and (with aging on) a `results_aged` batch. Rebuilding a prompt from stored events
  gives the same bytes.
- Deciding aging and sizing a compaction read only the events the prompt shows, never the history
  before (ADR 0170).
- Not changed: tool call arguments (a large file written by a call) and background job results do
  not age; results still cap at 20,000 characters when stored.
- Deferred: when one step's own fresh results overflow the window by themselves there is no safe
  cut, and the request still goes out over the window, as before this decision. Bounding those
  results with a stored cap is [#2669](https://github.com/arpan404/ace/issues/2669).
