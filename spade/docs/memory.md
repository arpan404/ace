# Memory, recall and asking the person

How Spade's bots remember ([ADR 0128](../../docs/adr/0128-spade-memory.md)). Agents and their
conversations are in [agents.md](agents.md); the prompt rules this keeps are in
[design.md](design.md) (Caching, Compaction).

## Notes

A note is one short fact, stored in Spade's SQLite (`notes`, searched through the FTS5 table
`notes_search`):

| Field          | Meaning                                                                      |
| -------------- | ---------------------------------------------------------------------------- |
| `id`           | `n_…`, never reused                                                          |
| `text`         | 1 to 500 characters, trimmed; line breaks become spaces                      |
| `scope`        | `agent` (one bot's own) or `shared` (the "About you" set every bot sees)     |
| `agent`        | the bot's id for `agent` notes, `null` for shared ones                       |
| `source`       | `person` (typed in the app), `bot` (a memory tool), `compaction` (extracted) |
| `created_at`   | ms since the epoch                                                           |
| `updated_at`   | ms since the epoch                                                           |
| `last_used_at` | when a prompt last showed it or a search returned it, else `null`            |
| `suggested`    | `true` while it waits for the person to keep it (see Compaction)             |

A bot sees its own notes and the shared ones, never another bot's. A scope holds at most 1,000
notes. Deleting a bot deletes its notes with it. Checking for the same note, checking the bound and
storing happen in one transaction, so concurrent saves never duplicate a note or pass the bound.

### Ranking

`memory_search`, `GET …/notes?q=` and per-turn recall rank the same way: the query's words (three
letters or more, common words left out) are matched with FTS5; each match's BM25 relevance is
multiplied by a recency factor (`1 / (1 + days since last used or updated / 30)`) and a use factor
(`1 + ln(1 + uses) / 4`). An embedding score can be added later as one more factor, without
changing callers.

## In the prompt

- **Index, in the cached top.** Before a conversation's first model call, and once after each
  compaction, Spade stores a `memory_indexed {text}` event: the shared notes, then the bot's own,
  most used and most recent first, up to 3,000 characters, each as `- [id] text`. The prompt's
  system part ends with the latest one. Between compactions it never changes, so the top stays
  byte-identical. It is stored even when empty, so the top is fixed before the first model call
  and a note added while that call is paused cannot change the resumed prompt.
- **Recall, at the tail.** When the person's message is stored, up to 5 notes ranked for its text
  are fixed in the message's `context`, leaving out notes the latest index or an earlier message
  since the last compaction already showed. Showing a note marks it used.

## Tools

| Tool             | Arguments                         | Does                                                      |
| ---------------- | --------------------------------- | --------------------------------------------------------- |
| `memory_save`    | `text`, `about_person` (bool)     | Saves a note: shared when `about_person`, else the bot's  |
| `memory_update`  | `id`, `text`                      | Rewrites one of the bot's or the shared notes             |
| `memory_forget`  | `id`                              | Deletes one                                               |
| `memory_search`  | `query`                           | Ranked notes the bot can see                              |
| `history_search` | `query`                           | Matches in the bot's own stored conversation, by position |
| `history_read`   | `from` (position), `count` (≤ 20) | Those events word for word                                |
| `ask_user`       | `question`                        | Asks the person and waits for their next message          |

The memory tools run without asking, except in a turn that read untrusted content or while the
prompt shows a summary drawn from untrusted content (`context_compacted` with `untrusted`), where each
asks the person first (risk `memory`). Saving text that matches an existing note in the same scope
(same words, or nearly all the same words) updates nothing and answers with the existing note.

`memory_save` and `memory_update` answer with JSON, which the app reads to show
"Remembered: …" in the conversation:

```json
{ "saved": { "id": "n_4", "text": "Prefers window seats", "shared": false } }
{ "updated": { "id": "n_4", "text": "Prefers aisle seats", "shared": false } }
```

A save that matched an existing note answers `{ "exists": { … } }` instead.

### Past text

The search index (`history_search` table) is filled from the event log as it is searched, so it
covers every event, including spans compaction summarised. It indexes the person's messages, the
bot's step text, tool results and background job results. A position is the event's `seq`, the
same number `GET /v1/conversations/{id}/events` reports.

### Asking the person

`ask_user {question}` stores `question_asked {reply, call_id, question}` and the turn waits. The
agent's `state` is `waiting` and `waiting_for` is `question`. The person's next message (not
another bot's) answers it: the message is stored as usual, the call's result reads "The person
answered; their reply follows.", and the turn carries on with the message after it. A restart
keeps the turn waiting; Stop ends it like any wait.

## Compaction

The compaction request also asks for `notes`: durable facts worth keeping beyond the
conversation. Each is saved with source `compaction` into the bot's scope, unless the scope
already has the same note; shared notes are only ever saved by the person or by `memory_save`
with `about_person`. Then the next prompt stores a fresh `memory_indexed`.

Facts are only as trustworthy as what they came from. When what the compaction summarised holds
untrusted content (a result of a tool marked untrusted, such as a web page or email, or another
bot's message, since the last compaction or folded into its summary), each fact is stored as a
suggestion (`suggested: true`): the person keeps it (`POST /notes/{note}/accept`) or dismisses it
(`DELETE`), and until kept no bot sees it in its index, recall or search. The compaction event
records `untrusted: true`, so a later summary that folds it in stays untrusted.

## API

All under `/v1`, with the bearer token. Bodies are JSON; errors are `{"error": "…"}`.

| Request                     | Body                      | Answer                                                                                                                          |
| --------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `GET /agents/{id}/notes`    |                           | `{"notes": [note…]}`, newest change first; `?q=` ranks                                                                          |
| `POST /agents/{id}/notes`   | `{"text"}`                | `201` and the note, source `person`; `200` and the existing note when one already says the same (a matching suggestion is kept) |
| `GET /notes`                |                           | The shared notes, as above                                                                                                      |
| `POST /notes`               | `{"text"}`                | `201` and a shared note, or `200` as above                                                                                      |
| `PATCH /notes/{note}`       | `{"text", "updated_at"?}` | The changed note; with `updated_at`, `409 {"error", "note"}` if the note changed since that version                             |
| `POST /notes/{note}/accept` |                           | The kept suggestion, `suggested: false`                                                                                         |
| `DELETE /notes/{note}`      |                           | `204`                                                                                                                           |

`400` for text that is empty or too long, `404` for an unknown agent or note, `409` when the scope
already holds 1,000 notes.
