# 0154: Spade's bots ask questions of several kinds, and the person can answer later

Status: accepted. Date: 2026-11-15. Decided by: the owner (2026-11-15: let a bot ask multiple
choice, multi-select and other kinds of question, each with its own card, and let the person
answer later). Builds on [spade/docs/memory.md](../../spade/docs/memory.md) (`ask_user`),
[spade/docs/harness.md](../../spade/docs/harness.md) (turns, steering, job results) and
[ADR 0152](0152-spade-helpers.md).

## Context

`ask_user {question}` takes one free-text question and pauses the turn until the person's next
message. A bot that needs one of three options writes them into the sentence and parses whatever
comes back. A bot that needs several answers asks one at a time. And the person can't say "not now":
the bot stays waiting, so the conversation reads as needing them until they reply.

## Decision

1. **Kinds.** `ask_user` takes `questions`, one to five, each with a `kind`:

   | Kind      | Fields                                              | The answer the bot reads                                |
   | --------- | --------------------------------------------------- | ------------------------------------------------------- |
   | `text`    | `placeholder?`                                      | the text                                                |
   | `choice`  | `options` (2–10, each `label`, `detail?`), `other?` | the label picked, or the person's own text when `other` |
   | `choices` | `options`, `min?`, `max?`, `other?`                 | the labels picked, in option order                      |
   | `confirm` | none                                                | yes or no                                               |
   | `number`  | `min?`, `max?`, `unit?`                             | the number                                              |
   | `date`    | `time?` (also ask the time)                         | an ISO 8601 date or date-time                           |

   Each question has `prompt` (required, short) and an optional `id`. The old form,
   `{question}`, still works as one `text` question. Arguments are checked before anything is
   stored; a call that breaks a rule is answered with an error saying which, so the bot can fix
   it. Kind names and fields are kept to these; an unknown kind is an error, not a guess.

2. **The answer is structured.** The person answers in the card, through
   `POST /v1/conversations/{id}/questions/{call_id}` with `{answers}`, one per question, checked
   against the question (an option that exists, the count within `min`/`max`, a number in range).
   It is stored as `question_answered {call_id, answers}`, and the call's result shows the bot each
   prompt with its answer. A message the person types while a question waits still answers it, as
   today: it becomes the answer to a single `text` question, or `other` text for a single `choice`
   or `choices` question that allows it, and otherwise is passed to the bot as their reply to the
   whole card.
3. **Answer later.** Every card has **Answer later**, which stores `question_deferred {call_id}`.
   The call is answered at once: "The person will answer later. Go on without it where you can,
   or end your reply saying what waits on it. Their answer will arrive as a <question_answer>."
   The turn carries on. The question stays open in the conversation, and the person answers it
   whenever they like, from the same card. That answer is stored as
   `question_answered {call_id, answers, late: true}` and delivered like a job result: it steers
   the open reply, or starts a new one, read by the bot as
   `<question_answer call="…">` with each prompt and answer.
4. **The bot can ask without waiting.** `ask_user {…, wait: false}` stores the question as
   deferred from the start: the bot keeps working, and the answer arrives later as in (3). For
   preferences that shape later work, not for anything the next step depends on.
5. **Dismissing.** The person can dismiss an open question (**Never mind**). The bot reads "The
   person dismissed this question." A waiting call is answered that way; a deferred one is
   delivered that way, like a late answer.
6. **State.** A bot waiting on a question reads as waiting on the person, as now. A deferred
   question doesn't block anything, so the bot can read as idle or done, but the conversation
   shows how many questions are left for later, in its list row ("1 question for later") and its
   header. That count is taken from the stored events, so it survives restarts. A deferred
   question never expires.
7. **Helpers** still can't ask (ADR 0152). **Bots on CLI brains** get the same tool through
   `spade_call`: waiting, deferring and dismissing answer the call the same way.
8. **Cards.** Each kind has its own card, drawn as the bot's bubble:
   - `choice` is a list of options, picked with a click or a digit key;
   - `choices` is a list with checks and a count;
   - `confirm` has Yes and No;
   - `number` and `date` use plain inputs;
   - a card with several questions shows them in order, with one **Send** at the end.

   Every card has **Answer later** and **Never mind**. All buttons are text, with no icons,
   following the design language. An answered card shows the answers in place of the inputs; a
   deferred card says "For later" and keeps its inputs.

## Consequences

- Bots stop parsing free text for choices, and can ask several things at once.
- The person is never held up by a question they'd rather leave; the bot learns to carry on.
- New events (`question_answered`, `question_deferred`, `question_dismissed`), a new endpoint, and
  a new `<question_answer>` tag in prompts. Rebuilt prompts stay byte for byte the same, since
  every answer is an event.

## Tests

- Each kind's answer is checked: an unknown option, too many picks, a number out of range and a
  missing answer are refused, and nothing is stored.
- A waiting card answered through the endpoint resumes the turn with the structured answers.
- A typed message answers a single text question, and is `other` for a choice question that
  allows it.
- Answer later answers the call at once and the turn carries on; the late answer then steers the
  open reply, or starts a new one when none is open, and is delivered once across a restart.
- `wait: false` never pauses the turn.
- A dismissed waiting question and a dismissed deferred one both reach the bot once.
- The conversation's count of questions for later is right after a restart, and goes down as
  each is answered or dismissed.
