# 0164: A Spade bot keeps a knowledge base and remembers its past tasks

Status: accepted. Date: 2026-11-15. Decided by: the owner (2026-11-15, Spade capability work
wave C: "memory and knowledge that scale over weeks and across a bot's workers"). Builds on
[ADR 0128](0128-spade-memory.md) (notes, `history_search`, the frozen index),
[ADR 0158](0158-spade-no-fixed-step-or-time-limits.md) (the bounded "already carried out" list),
[ADR 0159](0159-spade-goals-plans-and-verification.md) (goals, evidence, the check of done) and
[ADR 0161](0161-spade-orchestration-trees.md) (trees of workers, grants as subsets). The taint
rules are those of [spade/docs/memory.md](../../spade/docs/memory.md) and ADR 0130.

## Context

A bot's notes are one-line facts, at most 1,000 per bot, and flat. After weeks a conversation is
mostly summaries: the decisions behind the work, what a bot found out about a codebase or a
supplier, and what it tried last month and why that failed are in prose a compaction rewrote, or
in raw events `history_search` returns one at a time without dates. A worker a bot creates
(ADR 0161) starts with none of what its maker knows, and when a task ends nothing remembers how
it went, so the next similar task starts from zero.

Published practice for long runs keeps structured notes outside the context window and reads
them back on demand, loads content just in time from references (paths, ids, queries) rather
than preloading it, and treats compaction as lossy. Prompt caching constrains all of it: the
standing instructions change only at a compaction (design.md, Caching).

## Decision

1. **Each bot has a knowledge base.** An entry is a durable fact, decision, finding, how-to or
   summary, filed under a topic:
   - `id` (`k_…`), `topic` (a slug: lower-case words joined by `-`, `/` for subtopics, at most
     64 characters), `title` (one line, at most 200 characters), `body` (at most 8,000
     characters), `kind` (`fact`, `decision`, `finding`, `howto`, `summary`), `links` to other
     entries (`related`, `supports`, `contradicts`, `supersedes`, `part_of`), times, a use count;
   - `source {kind, detail?}`: `person`, `bot`, `web` (a URL), `file` (a path), `tool` (a tool
     name and call id) or `untrusted` (anything else from outside: an email, another bot);
   - `trust`: `trusted` or `untrusted`, and `author`: `person` or the bot that wrote it.

   It lives in Spade's SQLite with an FTS5 index over topic, title and body; no external
   service. Ranking is ADR 0128's (BM25 with recency and use), so an embedding score can be one
   more factor later.

2. **Trust is a label Spade sets, never the bot.** An entry is `untrusted` when its source is
   `web` or `untrusted`, when it is a `tool` whose output is untrusted, or when the prompt the
   writing call came from shows untrusted content (the same in-view rule notes follow).
   A bot's edit can lower an entry's trust, never raise it; only the person marks an entry
   trusted. Untrusted entries are always returned inside `<untrusted>` tags as data, and a
   tool result that shows one is itself untrusted, so it taints the turn as a web page does.
   They never reach the standing instructions: the topic index (5) lists only topics at least
   one trusted entry has, with trusted titles only, and counts the rest; a topic only untrusted
   entries have is left out, since its name is text the untrusted content may have chosen. With trust as a label rather than a gate, writing knowledge never asks
   the person (the auto-review classes it inside the bot's own state, audit C3): nothing in the
   base acts, and what came from outside stays marked wherever it is read.

3. **Shared down the tree.** A bot reads its own base and every ancestor's (its maker's, and
   theirs), read-only, so a worker starts with what its orchestrator knows. With
   `workers: true` an orchestrator also searches its workers' bases; those entries are another
   bot's words and always read as untrusted. Writes go to the writer's own base only. A
   worker detached from its parent (ADR 0161 decision 11) stops reading the parent's base.

4. **The person's entries are the person's.** The person reads and edits every entry over the
   API. A bot can't update, merge away or forget an entry the person wrote; it can link to it,
   or write a new entry that `supersedes` it. Summarising (7) never touches them.

5. **A short index in the standing instructions, frozen per compaction.** Before the first
   model call and once after each compaction, Spade stores `knowledge_indexed {text}`: up to 12
   topics from the bases the bot reads, most relevant to its task and open goal first (FTS
   match on the task's words, then use and recency), each with its entry count and up to three
   trusted titles (a topic with no trusted entry is left out), within 2,000 characters, plus how many past episodes it can search. The
   standing instructions end with the latest one, so the cached top changes only at a
   compaction. Entries written meanwhile reach the model through tool results.

6. **Episodes: a closed goal is remembered.** When a goal closes (ADR 0159: a `done` verdict,
   `verified`; the person ending it, `ended`; or the person ending it as failed, `failed`, with
   `DELETE /task/goal?outcome=failed`, stored as `goal_cleared {goal, failed: true}`), Spade
   folds the conversation into an episode and stores it, then `episode_stored {goal, episode}`:
   - the goal's title, text and criteria (with the last verdict's met or not);
   - what worked: the items closed with evidence and verified; what failed: items the check
     rejected, items left blocked, and what the verdict said is missing;
   - key decisions: the bot's `decision` entries written during the goal;
   - cost (spend recorded for the conversation between the goal's start and its close) and
     duration;
   - evidence links: each item's call (with its event position, for `history_read`), file or
     URL;
   - the bot's last `task_status` note, labelled as its own words;
   - `untrusted` when anything untrusted was in the prompt's view at any point of the goal,
     by the turn's rule (every untrusted event since the last compaction, and a summary drawn
     from untrusted content): from the last compaction before the goal started to its close, so
     a page read just before the goal counts. The episode then reads as untrusted wherever it is
     shown.

   An episode is built from events by a pure fold, never by a model, so it can't invent
   anything and costs nothing. It is stored once per goal (a unique key), and the check runs
   again before each model call, so a crash between the verdict and the episode loses nothing.
   `episode_search` finds the bot's own episodes and its tree's: "have I done this before?".

7. **History over weeks.** `history_search` also indexes each compaction's summary, shows each
   match's date, and takes `since`, `until` (dates) and `oldest_first`, so a bot weeks in finds
   what it did on day 1. ADR 0158's carried list already points at it for writes it no longer
   lists one by one.

8. **Hygiene, with no silent loss.**
   - **Duplicates:** writing an entry that says the same as one in the same base and topic
     (ADR 0128's rule over title and body) writes nothing and answers with the existing entry.
   - **Merge suggestions:** an entry sharing most of its words with another in its topic is
     written, and the answer names the similar ones; `GET …/knowledge/suggestions` lists such
     pairs; `knowledge_merge` (or the person) folds entries into one, appending their bodies,
     moving their links and keeping their sources.
   - **Growing topics:** a topic past 50 entries has its oldest bot-written entries folded,
     oldest first, into a `summary` entry until 30 remain. A summary is a digest (each folded
     entry's title, date and first lines), not a model's rewrite, and trusted and untrusted
     entries fold into separate summaries, so folding never launders trust. The folded
     entries' links move to the summary.
   - **Bounded storage:** each base holds at most `SPADE_KNOWLEDGE_BYTES` (default 4 MiB, set
     per bot with `PUT /v1/agents/{id}/knowledge/limit`). A write that would pass it first
     folds the base's oldest bot-written entries, oldest first across topics, until the base
     is at 90%. If only the person's entries and summaries remain, the write is refused as
     full, never by dropping anything. The person's entries are never folded or deleted except
     by the person.

## Options considered

- **Markdown files under the workspace's `knowledge/`.** Easy for the person to open, but trust
  would live in a second record that any file edit desynchronises, search needs an index
  anyway, and workers' bases would mean reading other bots' workspaces.
- **Notes with a bigger limit.** Notes are a flat list in every prompt's index; knowledge needs
  topics, bodies, links and provenance, and must not grow the cached top.
- **Model-written summaries and episodes.** Better prose, but a cost on every fold and close, a
  chance to invent, and a summary of untrusted text written by a model reading it. Kept as a
  later option behind the same store.
- **Embeddings now.** As in ADR 0128: keyword ranking first, an embedding score later.

## Consequences

- A bot can keep weeks of findings and decisions organised and searchable, hand them to its
  workers for free, and look up how a similar task went.
- What came from outside stays marked when it is written, summarised, merged, inherited or
  read back, and never becomes standing instructions.
- The base is bounded; past the bound old bot-written entries become digests, and the person
  sees each fold as a `summary` entry listing what it holds.
- Not built here: the UI, embeddings, model-written summaries, and a worker writing into its
  orchestrator's base.

## Tests

`spade_core::knowledge` is tested by tables: topic and text cleaning, the trust rule, similarity,
the fold plan (oldest bot-written first, person entries untouched, separate trust levels), the
index (trusted titles only, bound, relevance order), and the episode fold for each outcome.
`spade-store` tests use a temporary SQLite: FTS search, links, merges moving links, the unique
episode key, the byte bound. Engine tests with scripted model fakes: a write after reading a web
page is stored untrusted and read back in `<untrusted>` tags; a worker reads its maker's base; a
bot can't edit the person's entry; a verified goal stores one episode, also across a restart,
that `episode_search` finds; the index is in the top only after a compaction; `history_search`
finds day-1 text by date.

## UI (a later wave)

See [spade/docs/knowledge.md](../../spade/docs/knowledge.md), "What the UI needs".
