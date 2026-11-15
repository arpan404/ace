# Questions

Date: 2026-11-14. As built for [ADR 0154](../../docs/adr/0154-spade-questions-and-answering-later.md).
Extends [memory.md](memory.md) ("Asking the person") and [harness.md](harness.md) (turns, job
results). The pure rules are `spade_core::question` (arguments, answers, where each card
stands); the engine side is `engine/questions.rs` and the `ask_user` case in `engine/calls.rs`;
the API is `api/questions.rs`.

## The tool

`ask_user {questions, wait?}` asks one to five questions as one card. The old form,
`{question}`, is one `text` question.

| Kind      | Fields                                                 | Answer posted and stored                                        | The bot reads                               |
| --------- | ------------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------- |
| `text`    | `placeholder?`                                         | a string                                                        | the text                                    |
| `choice`  | `options` (2–10), `other?`                             | a string: an option's label, or own text if other               | the label, or "_text_ (in their own words)" |
| `choices` | `options` (2–10), `min?` (default 1), `max?`, `other?` | an array of labels (plus at most one own text)                  | the labels, comma-separated, option order   |
| `confirm` |                                                        | `true` or `false`                                               | yes or no                                   |
| `number`  | `min?`, `max?`, `unit?`                                | a number                                                        | the number, then the unit                   |
| `date`    | `time?`                                                | `YYYY-MM-DD`, or `YYYY-MM-DDTHH:MM[:SS][Z\|±HH:MM]` with `time` | the text                                    |

Every question has `prompt` (1 to 2,000 characters) and an optional `id` (unique in the card, up
to 64 characters). An option is `{label, detail?}` (a bare string is read as its label); labels
are 1 to 200 characters and unique ignoring case, details up to 500. `choices` counts the own text
toward `min` and `max`; `max` is at most the options (plus one with `other`). Text answers are 1 to
4,000 characters.

The arguments are checked before anything is stored. A call that breaks a rule (an unknown kind,
a field its kind doesn't have, too few options, `min` over `max`) is answered with an error naming
the question and the rule, and nothing waits.

`wait` defaults to `true`: the turn pauses until the person answers, defers or dismisses. With
`wait: false` the card is stored as deferred from the start, the call is answered at once ("Asked
without waiting…") and the bot keeps working.

Helpers never ask: every profile leaves `ask_user` out (helpers.md). Bots on CLI brains call it
through `spade_call` like any tool, and read the same results.

## Events

| Type                 | Fields                                      | Meaning                                                                                                                                                                                                                                                       |
| -------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `question_asked`     | `reply`, `call_id`, `question`, `questions` | The card. `question` is the prompts, one per line; `questions` each with its kind and fields as above (absent on older events: one `text` question)                                                                                                           |
| `question_deferred`  | `call_id`, `by_bot?`                        | Left for later: by the person, or by the bot asking with `wait: false` (`by_bot: true`). The call is answered at once                                                                                                                                         |
| `question_answered`  | `call_id`, `answers`, `late?`, `typed?`     | The answers, one per question, as checked and normalised (labels as the bot wrote them, `choices` in option order, a whole number without a fraction). `late`: the card was deferred. `typed`: a message the person typed, stored just before, stood for them |
| `question_dismissed` | `call_id`, `late?`                          | Never mind. `late` as above                                                                                                                                                                                                                                   |

`question_asked` example:

```json
{
  "type": "question_asked",
  "reply": "r_1",
  "call_id": "q1",
  "question": "Window or aisle?\nHow many nights?",
  "questions": [
    {
      "prompt": "Window or aisle?",
      "kind": "choice",
      "options": [{ "label": "Window" }, { "label": "Aisle", "detail": "Easier to get out" }],
      "other": true
    },
    { "prompt": "How many nights?", "kind": "number", "min": 1, "max": 14, "unit": "nights" }
  ]
}
```

What the bot reads:

- Answered in the card while it waits: the call's result is "The person answered." then each
  prompt with `Answer: …`, a blank line between.
- Answer later: "The person will answer later. Go on without it where you can, or end your reply
  saying what waits on it. Their answer will arrive as a <question_answer>." The turn carries on.
- Never mind while it waits: "The person dismissed this question."
- A late answer or dismissal is delivered like a job's result: it steers the open reply or starts
  one, and reads as `<question_answer call="q1">` with the prompts and answers (or the dismissal),
  then `</question_answer>`. The prompts are looked up from `question_asked`, also when a
  compaction cut left that event out of view, so a rebuilt prompt is the same bytes.

A late answer lands once: it is stored only while the card is still deferred, checked under the
lock every answer and message is stored under. After a restart a stored late answer opens its
reply like any job result (`needs_reply`), and nothing is delivered again.

## Typed messages

A message the person types (not another bot's, a routine's or a group's) while a card waits
answers it, as before. When exactly one card waits and it is a single `text` question, or a single
`choice` or `choices` question whose message names an option or allows `other`, the message is
stored with a `question_answered {typed: true}` holding the answer it stands for, so the card
shows it. In every case the call reads "The person answered; their reply follows." and the bot
reads the message itself next. A deferred card is only answered in the card.

## State

- A waiting card makes the bot read `waiting` with `waiting_for: "question"`, through restarts.
- A deferred card blocks nothing: the bot can read idle or done. It never expires, Stop leaves it,
  and it can be answered or dismissed whenever the person likes.
- A card stands as `waiting`, `deferred`, `answered`, `dismissed`, or `closed` (its turn ended
  before it was answered: Stop, a failure). All of it is folded from the stored events.

## API

| Request                                           | Body                                                                | Answer                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/conversations/{id}/questions/{call_id}` | one of `{"answers": [...]}`, `{"defer": true}`, `{"dismiss": true}` | `202`; `400 {"error"}` for a body that isn't exactly one of these, or answers that break the card's rules (the error names the question and the rule); `409` when that card isn't open (answered, dismissed, closed, unknown, or `defer` on a deferred one); `404` for an unknown conversation |
| `GET /v1/conversations/{id}/questions`            |                                                                     | `{"questions": [card…], "for_later": n}`, oldest first                                                                                                                                                                                                                                         |

A card in that list:

```json
{
  "call_id": "q1",
  "reply": "r_1",
  "questions": [ … as in question_asked … ],
  "standing": "waiting | deferred | answered | dismissed | closed",
  "asked_for_later": true,
  "answers": ["Aisle", 3],
  "typed": true
}
```

`asked_for_later`, `answers` and `typed` are left out when false or absent. `answers` is there once
the card was answered in the card or by a message that could stand for them.

`questions_for_later` (the deferred cards not yet answered or dismissed) is on each row of
`GET /v1/conversations` and on each agent of `GET /v1/agents`. The cards themselves are in the
conversation's events (`/events`, `/live`), so a client can draw them from what it already reads.

Answers are checked against the card: an option that exists (ignoring case and spaces at the
ends), the picks within `min` and `max`, a number in range, a real date, and an answer for every
question. A refused answer stores nothing.

## Not built yet

- The web and iPhone cards (ADR 0154, "Cards") come next, built against the shapes above.
