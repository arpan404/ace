# Knowledge, episodes and history over weeks

How a bot keeps what it learns beyond one-line notes ([ADR 0164](../../docs/adr/0164-spade-knowledge-and-episodes.md)).
Notes, recall and `history_read` are in [memory.md](memory.md); goals and the check of done in
[ADR 0159](../../docs/adr/0159-spade-goals-plans-and-verification.md); trees of workers in
[workers.md](workers.md).

## Entries

An entry lives in Spade's SQLite (`knowledge`, searched through the FTS5 table
`knowledge_search` over topic, title and body; links in `knowledge_links`):

| Field                                              | Meaning                                                                          |
| -------------------------------------------------- | -------------------------------------------------------------------------------- |
| `id`                                               | `k_…`, never reused                                                              |
| `agent`                                            | the bot whose base holds it                                                      |
| `topic`                                            | lower-case words joined by `-`, `/` between subtopics, at most 64 characters     |
| `title`                                            | one line, 1 to 200 characters                                                    |
| `body`                                             | 1 to 8,000 characters, line breaks kept                                          |
| `kind`                                             | `fact`, `decision`, `finding`, `howto`, or `summary` (made by Spade)             |
| `source {kind, detail}`                            | `person`, `bot`, `web` (URL), `file` (path), `tool` (name and call), `untrusted` |
| `trust`                                            | `trusted` or `untrusted`, set by Spade                                           |
| `author`                                           | `"person"` or `{"bot": id}`                                                      |
| `created_at`, `updated_at`, `last_used_at`, `uses` | times in ms, and how often searches returned it                                  |

Ranking is notes' (BM25 times recency times use, [memory.md](memory.md#ranking)).

### Trust

An entry is untrusted when its source is `web` or `untrusted`, when it is a `tool` whose output
is untrusted (or a tool Spade doesn't know), or when the prompt the write came from shows
untrusted content (any untrusted event since the last compaction, or a summary drawn from one).
A bot's edit or merge can lower an entry's trust, never raise it; the person raises it with
`PATCH {"trusted": true}`. Untrusted entries, and any entry of a worker's base, come back to a
bot inside `<untrusted entry="k_…">` tags with `<` and `>` replaced, and such a result is itself
untrusted, so it taints the turn as a page does.

Writing knowledge doesn't ask (the tools are classed inside the bot's own state). Deleting does
wait: `knowledge_forget` is refused while untrusted content is in view.

### Whose base

A bot reads its own base and its makers' (ADR 0161), read-only; `workers: true` adds its
workers'. It writes only to its own. The person's entries (author `person`) are never changed,
merged away, folded or deleted by a bot; a bot writes a new entry that `supersedes` one.

## In the prompt

Before the first model call and once after each compaction, when there is anything to show,
Spade stores `knowledge_indexed {text}`: up to 12 topics of the bases the bot reads, those whose
words match its task and open goal first, then the most recent, each with its entry count, how
many are untrusted, and up to three trusted titles, within 2,000 characters; and how many past
episodes `episode_search` can find. The standing instructions end with the latest one (after
the notes index), so the top changes only at a compaction. Untrusted titles are never shown.

## Tools

| Tool               | Arguments                                                                | Does                                                  |
| ------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------- |
| `knowledge_write`  | `topic`, `title`, `body`, `kind?`, `source?`, `source_detail?`, `links?` | Writes an entry, or answers with the one that says it |
| `knowledge_search` | `query?`, `topic?`, `kind?`, `workers?`                                  | Ranked entries of the bases the bot reads, or a topic |
| `episode_search`   | `query?`                                                                 | Past episodes of the bot's tree, or the latest        |
| `knowledge_read`   | `id`                                                                     | One entry whole, with its links (deferred)            |
| `knowledge_update` | `id`, `topic?`, `title?`, `body?`, `kind?`                               | Changes one of its own entries (deferred)             |
| `knowledge_link`   | `from`, `to`, `relation`                                                 | Links its entry to one it reads (deferred)            |
| `knowledge_merge`  | `into`, `from: [id]`                                                     | Folds its entries into one (deferred)                 |
| `knowledge_forget` | `id`                                                                     | Deletes one of its own entries (deferred)             |

`knowledge_write` answers
`{"written": {id, topic, title, trust}, "alike"?: [{id, title}], "folded"?: n, "why"?}`, or
`{"exists": {id, title}}`. `alike` lists entries of the topic sharing at least 60% of their
words, for `knowledge_merge`. A search shows each entry as
`[k_…] topic · kind · whose, source …`, its title and up to 1,500 characters of its body.

`history_search` (memory.md) also finds compaction summaries, shows each match's date
(`[position 41] 2026-11-02: …`), and takes `since` and `until` (days, `until` included) and
`oldest_first`.

## Episodes

When a goal closes (a `done` verdict: `verified`; the person ending it: `ended`; or ending it
with `?outcome=failed`: `failed`, stored as `goal_cleared {goal, failed: true}`), Spade folds an
episode from the events, stores it in `episodes` (searched through `episodes_search`), then
stores `episode_stored {goal, episode}`. One per goal: the store's key is the conversation and
goal, and each conversation is checked again before its first model call after a start.

```json
{
  "id": "e_7",
  "agent": "a_2",
  "conversation": "c_3",
  "goal": "g1",
  "title": "Green build",
  "outcome": "verified",
  "untrusted": false,
  "cost_micros": 41000,
  "started_at": 0,
  "closed_at": 0,
  "duration_ms": 0,
  "episode": {
    "goal": "g1",
    "title": "Green build",
    "text": "Make the build green",
    "outcome": "verified",
    "criteria": [{ "id": "1", "text": "tests pass", "met": true }],
    "worked": [{ "item": "1", "text": "fix the flaky test" }],
    "failed": [{ "item": "2", "text": "tag the release", "why": "no tag rights" }],
    "missing": [],
    "decisions": [{ "id": "k_12", "title": "Pin the clock in tests" }],
    "evidence": [{ "kind": "output", "call": "c3", "item": "1", "position": 9 }],
    "note": "pinned the clock in the test",
    "untrusted": false
  }
}
```

`decisions` are the bot's own `decision` entries written while the goal was open; `note` is the
bot's last `task_status` note, its own words; cost is the spend recorded for the conversation
between the goal's start and close. An episode with `untrusted` (something untrusted was read
during the goal), or a worker's, is shown to a bot as data in `<untrusted>` tags.

## Hygiene and bounds

- A write that says the same as an entry of its topic (ADR 0128's rule over title and body)
  writes nothing.
- A topic past 50 entries folds its oldest bot-written entries into `summary` entries until 30
  remain. A summary is a digest: "Summary of N older entries on topic (from to to)", then one
  line per entry (title, date, kind, its first 240 characters). Trusted and untrusted entries
  fold into separate summaries. Folded entries' links move to the summary.
- A base holds at most its size in bytes of topic, title and body: `SPADE_KNOWLEDGE_BYTES`
  (default 4 MiB), or the person's `PUT …/knowledge/limit`. A write that would pass it first
  folds the base's oldest bot-written entries (summaries included), oldest first across topics,
  until the base with the new entry is at 90%. When only the person's entries are left to fold
  it is refused (`409`, or the tool says so). Edits and merges are not folded for.

## API

All under `/v1`, with the bearer token. Errors are `{"error": "…"}`.

| Request                                  | Body                                                    | Answer                                                                                                           |
| ---------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `GET /agents/{id}/knowledge`             |                                                         | `{"entries": [entry…]}`, newest change first; `?q=` ranks; `?topic=`                                             |
| `POST /agents/{id}/knowledge`            | `{topic, title, body, kind?}`                           | `201` and the entry (source `person`, trusted); `200` and an existing one that says the same                     |
| `GET /agents/{id}/knowledge/topics`      |                                                         | `{"topics": [{topic, entries, untrusted, by_person, bytes, updated_at}], "bytes", "limit_bytes", "suggestions"}` |
| `GET /agents/{id}/knowledge/suggestions` |                                                         | `{"merges": [{a, b, overlap}]}`, most alike first                                                                |
| `PUT /agents/{id}/knowledge/limit`       | `{"bytes": n \| null}`                                  | `{"limit_bytes"}`; `null` goes back to the default                                                               |
| `GET /knowledge/{entry}`                 |                                                         | The entry with `links: [{entry, relation, direction: to \| from}]`                                               |
| `PATCH /knowledge/{entry}`               | `{topic?, title?, body?, kind?, trusted?, updated_at?}` | The entry; with `updated_at`, `409 {"error", "entry"}` if it moved                                               |
| `DELETE /knowledge/{entry}`              |                                                         | `204`                                                                                                            |
| `POST /knowledge/{entry}/links`          | `{to, relation?}`                                       | `204`; both entries of one bot                                                                                   |
| `DELETE /knowledge/{entry}/links/{to}`   |                                                         | `204`                                                                                                            |
| `POST /knowledge/{entry}/merge`          | `{from: [id]}`                                          | The merged entry                                                                                                 |
| `GET /agents/{id}/episodes`              |                                                         | `{"episodes": [episode…]}`, newest first; `?q=` searches                                                         |
| `GET /episodes/{episode}`                |                                                         | One episode                                                                                                      |
| `DELETE /agents/{id}/task/goal`          | `?outcome=failed`                                       | `204`; ends the goal as failed (ADR 0159 otherwise)                                                              |

`400` for text that doesn't fit, `404` for an unknown agent or entry, `409` when the base is
full of the person's entries.

## What the UI needs

- **A Knowledge tab in a bot's profile:** topics as a tree (`/` subtopics) with counts, an
  untrusted count and the base's size against its bound (`…/topics`); entries per topic, newest
  first, with a search field (`?q=`).
- **An entry view and editor:** title, body, kind, topic; the source (a link for `web`, a path
  for `file`, the call for `tool`, opening it in the activity log); who wrote it (the person or
  which bot, a maker's or worker's name); trust as a quiet "untrusted" label with "Trust this"
  (`PATCH trusted: true`); links both ways, with add and remove; edit in place with `updated_at`
  and the `409` "changed meanwhile" case; delete.
- **Summaries:** a `summary` entry reads as "Summary of N older entries", its lines as a list.
- **Merge suggestions:** pairs from `…/suggestions` with "Merge" (`POST …/merge`) and "Keep both"
  (client-side dismiss for now).
- **Size:** the bound in Settings or the tab (`PUT …/limit`), and a "full" notice on `409` saying
  only the person's entries are left.
- **Episodes:** a list per bot (`…/episodes`): title, outcome (verified, ended, failed), dates,
  duration and cost; an episode opens to criteria with met marks, what worked, what failed and
  why, what was missing, decisions (opening their entries), evidence (opening the call at its
  position, the file or the URL), and the bot's own note marked as its words.
- **Ending a goal:** the goal's menu offers "End" and "End as failed" (`?outcome=failed`).
- **In the conversation:** `knowledge_write` results as one quiet line ("Kept: Acme seat price",
  "untrusted" when so), and `episode_stored` as a line on the activity timeline.
