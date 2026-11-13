# 0144: Autonomous bots: access levels, auto-review, keep going until done

Status: accepted. Date: 2026-11-13. Decided by: the owner (2026-11-13: "spade is missing true
autonomous behavior, no full access or auto review system and nothing"); the defaults below were
taken by the owner's assistant and are open to the owner's confirmation. Amends
[ADR 0130](0130-spade-skills-and-workspace.md) decision 7, the approval rules of
[ADR 0133](0133-spade-cli-brains.md) and [ADR 0135](0135-spade-research-and-oversight.md)
decision 4. Builds on [ADR 0127](0127-spade-main-bot-and-chat.md) (the chat shows no tool calls)
and [ADR 0002](0002-local-cli-providers.md) (no credentials).

## Context

Every write a Spade bot makes asks the person first (ADR 0130: every shell command, unless that
exact command was allowed always), and the model review of ADR 0135 can only add questions. A bot
also stops when its reply ends: a task of twenty steps needs the person to write twenty times, or
the bot to cram everything into one reply. The person wants bots that do the work: run the
routine steps on their own, check with a second model rather than with them, and keep going
until the task is done, while the things that matter (money, speaking for them, deleting their
data, credentials) still come to them.

## Decision

1. **Each bot has an access level:** `ask`, `auto_review` or `full_access`. A bot made from now on
   starts on `auto_review`. The first time this build opens a database it pins every existing
   conversation to `ask`, so no existing bot changes behaviour. The person changes the level per
   bot (`PATCH /v1/agents/{id}` with `access`, or `access` when creating one). The level is stored
   as an `access_changed` event in the bot's conversation, so a restart rebuilds it and the
   activity log shows the change. It holds from the bot's next tool call: the gate reads it as it
   decides each call, never during one. Spade, the main bot, is a bot
   like the others here.
2. **`ask`** keeps today's rules unchanged (ADR 0130, 0133, 0135, 0142), the model review of
   ADR 0135 included.
3. **`auto_review`.** A call the rule gate would ask about goes to a reviewer model instead: the
   person's review model, else the fast model, else the bot's own. The reviewer sees the bot's
   task and folder, the person's latest three messages, the call with its arguments, and whether
   the turn read untrusted content, naming it. Every one of those is passed as quoted data in
   tags, with `<` and `>` replaced so nothing can close a tag. It answers `approve`, `refuse`
   with a reason, or `escalate`, plus `outward_or_irreversible`.
   - `approve` runs the call. `refuse` stores the call's result as `Not run: <reason>` (not an
     error) and tells the bot not to retry the same call. `escalate` becomes the usual approval
     bubble, carrying the reviewer's one line as `reviewer_reason`.
   - An approved call still escalates when the reviewer marks it `outward_or_irreversible` and it
     is a shell command, or when the turn read untrusted content.
   - **Always the person, whatever the reviewer would say:** payments and purchases, sending a
     message or email as the person, posting or publishing, deleting outside the bot's folder,
     changing sign-ins, keys or access, and any call Spade can't classify. These never reach the
     reviewer; the bubble says which rule applied. Calls are classed by what the tool says about
     itself: Spade's own tools by name; ace's tools by name and risk; an app's tools by their name
     and description's verbs and their MCP annotations (`destructiveHint` deletes;
     a tool with no annotations at all is unknown).
   - A reviewer that fails, times out (60 s), answers what doesn't parse, or finds the bot at its
     cap escalates. Reviewer calls count toward the bot's caps. Every verdict, the rules' ones
     included, is stored as `call_reviewed` before anything runs and shows in the activity log;
     a restart reuses a stored verdict rather than paying again.
   - **Taint:** reading untrusted content no longer asks by itself. The reviewer is told and told
     to be stricter, and a call that reaches outside the bot after untrusted content escalates
     without a review.
4. **`full_access`.** Nothing asks. The spending caps, the activity log, Stop and the trust
   allowlist for files and skills (ADR 0130) still hold.
5. **No level reads credentials.** On every level, and for reads too, a call is refused when its
   arguments name a place where CLI sign-ins or provider credentials live (`~/.codex`,
   `~/.claude`, `~/.config/gh/hosts.yml`, `.aws`, `.ssh`, `.netrc`, the keychain and the like),
   read by any program, or run a tool that reads secrets (`security find-*-password`,
   `secret-tool lookup`, `gpg --export-secret*`, keyring CLIs). It is a denylist, a guard rail
   rather than a sandbox; it can't be complete.
   - Shell commands are also read without a model: sending over the network, mail, publishing,
     changing servers, writing or deleting outside the bot's folder, driving other apps, admin
     rights and payments go to the person whatever the reviewer says, and so does a command
     Spade can't read for sure (here-documents, `eval`, a pipe into a shell).
   - The reviewer reads the whole call; one too long for its prompt goes to the person. Taint is
     anything untrusted still in the model's view, from any turn since compaction.
   - A routine saved or changed while untrusted content is in view always asks the person, on
     every level, and its firings count as untrusted.
6. **A bot keeps going until its task is done.** The bot keeps its task state with
   `task_status {status: working | waiting | blocked_on_person | done, note?}`, a read tool; the
   latest call is the state. When a reply ends finished with the task `working`, the engine
   stores `task_continued {step, nudge}` with a new `reply_started` and runs it as a normal turn.
   The model reads the nudge as a note from Spade, never as the person's words. Taint carries
   across these steps back to the latest message. Policy (`spade_core::task`, pure):
   - at most 25 steps on its own, counted from the person's latest message;
   - a step with no effect (no write, delete or note started; no change to `todo` or
     `task_status`) makes the next wait 30 s, doubling to at most 15 minutes; three in a row
     pause the task;
   - a running background job holds it: the job's result starts the next turn;
   - it never starts while the bot is at a cap, Spade is closing, the person has the bot's
     computer, or after a stop.
     On a pause Spade stores `task_paused {reason: budget | no_progress, steps}` once, which the
     person sees; the person's next message starts afresh. `waiting` means the bot saves a
     routine to check back (ADR 0129); `blocked_on_person` means it asked with `ask_user`. A
     message from the person while a step runs steers that step; Stop ends it and calls off a step
     waiting to start. The chat shows only the bot's messages and the status line (ADR 0127). A
     step waiting out a backoff is forgotten when Spade stops; reopening asks the policy again.
7. **CLI brains (ADR 0133)** reach Spade's tools through the same gate, so the level maps the
   same way: `auto_review` sends what would ask to the reviewer and `full_access` lets the
   allow-listed ace tools run. `task_status` and continuation work for them too; the nudge goes
   to the CLI as its next turn. The CLI's own built-in tools stay ungated by Spade, as before.
8. **API.** `access` on `POST /v1/agents` and `PATCH /v1/agents/{id}`; every agent shows
   `access`, `task_state` (`{status, note?}` or `null`) and `continuing` (a step Spade started
   is running, or one waits to start). `approval_requested` carries `reviewer_reason`. The
   activity log has kinds `access` and `task`, and review entries now include `refused`.

## Options considered

- **Keep the level in the settings table, like caps.** Simpler to read, but it lives apart from
  the history it governs; the event is folded with everything else the roster already reads.
- **A continuation inside one long turn.** One reply that never ends would hold the person's
  steering and the turn's step and cost limits; separate turns reuse every rule a turn already
  has, Stop included.
- **Letting the reviewer approve anything.** The few kinds of call above are the ones a mistake
  can't take back or that speak for the person; a second model's judgment isn't enough for them.

## Consequences

- New bots no longer ask about routine work in their folder; existing ones keep asking until the
  person changes them.
- A bot's task can spend up to its step budget without a message; the caps bound the money.
- Classification by words can miss a tool named oddly; an app tool with no annotations always
  goes to the person, and a wrong guess only ever reaches the reviewer, never runs unseen on
  `auto_review` for the kinds that always ask by name.

## Tests

`spade_core::autonomy` and `spade_core::task` are tested by tables. Process tests in
`spade/crates/spade-server/tests/autonomy.rs`, with a fake model as bot and reviewer.
