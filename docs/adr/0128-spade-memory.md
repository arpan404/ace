# 0128: Spade's bots remember: notes, recall of past text, and asking the person

Status: accepted. Date: 2026-11-12. Decided by: the owner (2026-11-12: make Spade complete and
better than the best persistent-agent products; memory lives in Spade's database and is shown to
the person as editable notes; each bot has its own notes and one shared "About you" set is
visible to every bot). Builds on [ADR 0126](0126-spade-agents.md) and
[ADR 0127](0127-spade-main-bot-and-chat.md); fills the "Memory" feature and the
`history_search`/`history_read` promise in `spade/docs/design.md`.

## Context

A bot is one long conversation (ADR 0126). Compaction keeps it inside the model's context, but a
summary loses detail, and nothing a bot learns reaches another bot. The person repeats
themselves: their name, how they like things done, what a bot already found out. A bot that is
unsure has no way to ask and wait; it guesses or ends its reply.

Two constraints shape the answer. Prompts are append-only so the cache hit rate stays near 99%
(design.md, Caching): anything that changes per turn rides with the new message, never in the
cached top. And the person must be able to see and correct what a bot believes about them.

## Options considered

- **Memory as files the bot edits.** Simple to show, but search, ranking, scopes and concurrent
  edits all need building over files anyway, and a file per bot does not give a shared set.
- **Embeddings and a vector index now.** Better recall for paraphrases, but a model download or
  an endpoint call on every message, and a dependency to ship. Keyword search with recency covers
  the short notes this stores; the design leaves room to add embeddings as one more signal.
- **Chosen:** notes in Spade's SQLite, searched with FTS5 and ranked with recency and use, shown
  to the person as an editable list.

## Decision

1. **A note is a short fact in Spade's database.** Fields: id, text (1 to 500 characters, one
   paragraph), scope (one bot, or shared), source (`person`, `bot`, or `compaction`), created,
   updated and last used times, and a use count. Each bot sees its own notes and the shared
   "About you" notes; never another bot's. A scope holds at most 1,000 notes. Deleting a bot
   deletes its notes; shared notes stay.

2. **Bots manage their notes with tools.** `memory_save` (text, and whether it is about the
   person, which makes it shared), `memory_update` (id, text), `memory_forget` (id) and
   `memory_search` (query). They run without asking, except in a turn that has read untrusted
   content (a web page, an email, another bot's message), where each asks the person first: a
   note outlives the turn, so text planted in a page must not become a standing belief.

3. **Relevant notes ride with the new message.** When the person's message is stored, the notes
   most relevant to it (at most 5, and none the prompt already shows) are fixed in that message's
   per-turn context, so the prompt only grows at its end and a restart rebuilds it byte for byte.
   Showing a note counts as using it.

4. **A small index of notes sits in the cached top, frozen per compaction.** Before a
   conversation's first model call, and once after each compaction, Spade stores a
   `memory_indexed` event with the shared notes and the bot's own most used and most recent notes
   (up to 3,000 characters). The prompt's top uses the latest one, so it changes only when the
   conversation compacts, which already costs one cache miss. Notes saved meanwhile reach the
   model through tool results and per-turn recall.

5. **Ranking is FTS5 plus recency and use.** Keyword relevance (BM25) is weighted up for notes
   used often and recently and down with age. No embeddings for now; a later embedding score is
   one more input to the same ranking, behind the same store interface.

6. **Compaction extracts notes.** The compaction request, already appended to the conversation's
   cached prompt on its own model, also asks for durable facts worth keeping beyond the
   conversation (about the person, standing preferences, decisions). They are saved with source
   `compaction`, de-duplicated against the scope's existing notes (the same words, or nearly
   all the same words, count as the same note), so extraction adds nothing twice.

7. **Bots recall exact past text.** `history_search` finds the bot's own stored conversation
   (every message, reply and tool result, including the parts compaction summarised away) by
   keyword, with each match's position. `history_read` returns a window of events by position,
   word for word. The search index is built from the event log as it is searched, so old
   conversations need no migration and the log stays the source of truth.

8. **A bot can ask the person and wait.** `ask_user` (a question) stores a `question_asked`
   event and the turn waits, as it waits for an approval: the agent's state is waiting and its
   `waiting_for` is `question`. The person's next message answers it (the app may present it as a
   reply to the question bubble); the call's result points to that message, and the turn carries
   on. The wait survives a restart; Stop ends it.

9. **The person sees and edits memory.** In the app, a bot's menu has "Memory": its notes as an
   editable list (add, edit in place, delete). Settings › Spade › "About you" holds the shared
   notes. In the conversation, a note a bot saved shows as one muted line ("Remembered: prefers
   window seats") that opens it for editing; no other tool activity shows (ADR 0127 decision 4).
   A question shows as the bot's bubble.

10. **The API** under `/v1`: `GET`/`POST /agents/{id}/notes`, `GET`/`POST /notes` (shared),
    `PATCH`/`DELETE /notes/{note}`; `GET` takes `q` to search. Documented in
    `spade/docs/memory.md`.

## Consequences

- Bots stop asking for what the person already told them, and the person can correct a belief
  in one edit.
- Recall costs one SQLite query per message and adds only to the tail of the prompt; the cached
  top changes once per compaction, as before.
- Keyword search misses paraphrases ("flight" for "plane"); embeddings are the planned remedy.
- The index of past text grows with the event log, one row per message or result.
- A wrong note persists until the person or the bot fixes it; the muted "Remembered" line and the
  Memory list are how the person notices.
- Events stored before this decision decode as before; a `question_asked` or `memory_indexed`
  event unknown to an older Spade is kept as raw data.

## Tests

- Notes survive a restart; a bot's own notes reach only it, shared notes reach every bot.
- A relevant note reaches the tail of the prompt, and the cached top is byte-identical turn to
  turn, even after a note is saved, until the next compaction.
- Compaction extracts notes once: compacting again over the same facts adds no duplicate.
- `history_search` finds text that compaction summarised away; `history_read` returns it exactly.
- `ask_user` sets `waiting_for` to `question`; the person's message resumes the same turn, which
  then finishes with the answer in view.
- The app's Memory list adds, edits and deletes notes through the API.
