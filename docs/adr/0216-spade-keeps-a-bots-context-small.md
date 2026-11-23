# 0216: Spade keeps a bot's context small: a working budget, aged results, the person's words kept

Status: accepted. Date: 2026-11-22. Decided by: the owner (2026-11-22: bots "keep forgetting the
things I told it previously"; the harness "feels like making the agent weak in long horizon
task"). Amends [ADR 0158](0158-spade-no-fixed-step-or-time-limits.md) on when compaction runs;
its rule that nothing ends a turn stands.

## Context

Spade compacted only once the endpoint's last reported prompt reached 75% of the model's own
window (200,000 tokens for a model that doesn't say; `SPADE_CONTEXT_TOKENS` capped it as a cost
choice). The person's models (DeepSeek V4.1 Flash, Kimi K3.1 Pro on OpenCode Go) list windows of
about 1,000,000 tokens, so a bot carried up to about 750,000 tokens before its first compaction,
and the person's live Spade never compacted once. Every tool result stayed in the prompt for good
(results over 20,000 characters keep their first and last 10,000), so in a long task most of the
prompt was file reads and command output from hours before, and the person's instructions were a
small share of it, far from the end.

Two things went wrong at once:

- **Quality falls well before the window.** Published long-context measurements agree that models
  use a long prompt much worse than a short one, and far below their listed window: RULER (Hsieh
  et al., 2024) finds most models' effective length a fraction of the claimed one; NoLiMa
  (Modarressi et al., 2025) finds most models below half their short-prompt score by 32k tokens
  once the match is not literal; Chroma's "Context Rot" (2025) shows the same decline on simple
  tasks as input grows. A bot that reads its instructions back through 500k tokens of tool output
  forgets them, which is what the person saw.
- **Every step pays for the whole prompt.** A prompt cache makes the repeated part cheaper, never
  free: at 500k tokens each step reads half a million cached tokens.

When compaction did run it summarised the person's own messages along with everything else, so a
standing instruction ("always run the tests first") lived on only if the summary happened to keep
it.

## Decision

1. **A working budget, the window the ceiling.** A conversation compacts once its reported prompt
   reaches the working budget, or 75% of the model's window when that is smaller
   (`compaction::Budget::trigger`). A compaction keeps recent turns worth the same share of that
   trigger as before (35/75, about 60k tokens at the default). The default is **128,000 tokens**
   (`compaction::WORKING_TOKENS`): past the range where the papers above still see near-full
   quality for most current models, but large enough that a turn reading a few large files does
   not compact every step. A model with a 200k window now compacts at 128k instead of 150k; one
   with a 128k window still compacts at 96k. The person sets it per bot or for every bot as `context_tokens` on the existing
   model-roles settings (`PUT /v1/agents/{id}/models`, `PUT /v1/models/roles`), resolved like an
   effort: the bot's, else the global one, else the default; at least 16,000 tokens.
   `SPADE_CONTEXT_TOKENS` still caps the window.
2. **Old tool results age out, in batches.** A tool result shown in a later prompt is replaced by
   a short stub once aging reaches it: the tool, what it was called with (arguments shortened as
   in the carried-out list), its size, and how to get it back (`history_read` at its position,
   `history_search`, or calling the tool again). Never aged: the person's messages, the bot's own
   words, `ask_user` cards and answers, approvals (they are not results), errors, results of
   2,000 characters or less, results with images, `skill_load` and `tool_search` results, the
   results of the latest 4 steps and at least the latest 8 results. Aging is fixed by a stored
   event, `results_aged { before }`: every result before that index that may age is a stub. The
   engine stores one before a model call only when the results that would age add up to at least
   64,000 characters (about 16,000 tokens) (`aging::due`), so the prompt changes in batches.
3. **Compaction keeps the person's words.** Each compaction stores the person's own messages from
   the span it summarises, word for word, on its `carried` ledger (`said`, `said_earlier`),
   carried forward from compaction to compaction like the writes already carried out. The stored
   summary is the model's summary, then "What the person said earlier, word for word", then the
   writes already carried out. A message over 3,000 characters keeps its start and says where the
   rest is. The list is bounded at 24,000 characters: the newest message always stays, then
   standing instructions (messages with "always", "never", "from now on", "don't", "remember" and
   the like), newest first, then the rest, newest first; what doesn't fit is counted and pointed
   at `history_search`. The summary request now asks for every decision and who made it and for
   open commitments (what the bot said it would do and hasn't), stored as `commitments` and shown
   as "Commitments still owed".

The new fields are additive and read leniently: a `context_compacted` from an earlier build reads
as before, and a `carried` ledger without `said` carries nothing.

## The prompt cache

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
about 0.25, no write premium), about 70% less. The prompt stays near 50k tokens instead of growing
without end, which is the quality gain this decision is for. In practice the working budget would
have compacted the unaged run several times, each compaction rewriting the whole prompt; aging
makes compactions rarer as well.

## Consequences

- A bot rereads an old result when it needs it; the stub tells it how. Tools whose results it
  must keep following (skills) never age.
- The prompt changes at three kinds of point, all stored: a compaction, a new skill/notes index
  after one, and a `results_aged` batch. Rebuilding a prompt from stored events gives the same
  bytes.
- Deciding aging reads only the events the prompt shows (back to the latest `results_aged` or the
  latest compaction's cut), never the history before (ADR 0170).
- The person's live bots compact far sooner on 1M-token models: about 128k tokens instead of
  750k. A person who wants more sets `context_tokens` per bot.
- Not changed: tool call arguments (a large file written by a call) and background job results do
  not age; results still cap at 20,000 characters when stored.
