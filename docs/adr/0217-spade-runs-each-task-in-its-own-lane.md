# 0217: A Spade bot runs each task in its own lane

Status: accepted (2026-11-23, built on `ace/spade-lanes`; see "As built"). Date: 2026-11-22.
Asked for by the owner (2026-11-22: "multitasking and many others are fucked"; bots forget earlier
asks when given new ones). The owner answered the first
draft's open questions the same day (16 lanes at once, a `task` model role, main's long work moves
to a lane by itself, no CLI case, mock both task list layouts); they are folded in below. Amends
[ADR 0162](0162-spade-model-routing.md) and [ADR 0213](0213-spade-roles-think-at-an-effort.md)
with one role. Builds on
[ADR 0152](0152-spade-helpers.md) (helpers), [ADR 0158](0158-spade-no-fixed-step-or-time-limits.md)
(no fixed limits), [ADR 0159](0159-spade-goals-plans-and-verification.md) (goals, plans, the
check of done), [ADR 0160](0160-spade-wake-and-owned-services.md) (wakes),
[ADR 0161](0161-spade-orchestration-trees.md) (worker trees) and
[ADR 0166](0166-spade-has-no-spending-limits.md) (spend shown, never capped). Assumes the asks
ledger (ADR draft on `ace/spade-asks-ledger`) and the working context budget with tool-result
aging (ADR draft on `ace/spade-context-budget`). Numbered 0217 because four open PRs claim 0214
and those two drafts are expected to take 0215 and 0216. AGENTS.md priority 1 applies
throughout: a bot never reads as done while any of its tasks works or waits on the person.

## Context

A bot has one conversation, and that conversation has at most one open reply. A message the
person sends while a reply is open steers it (`chat-core.md`, "Steering is the default"): it is
stored, the next model call sees it after the running tools' results, and the turn carries on.
That is right for "use March, not February", where the new words change the work under way. It
fails when the new words are a second, independent request:

- **One context, two jobs.** The model reads the second ask as the latest thing the person
  wants. It finishes that and ends the reply, and the first ask stays half done with nothing
  holding it open. The asks ledger closes this gap for answering: each ask stays open until the
  bot closes it, and the stop check refuses a reply that ends with asks still open. It does not
  make the two jobs run side by side.
- **Serial work.** "Book the flights" and "draft the quarterly note" can't both make progress. The
  second waits behind every step of the first, even when the first is sitting on a slow job.
- **One goal per conversation.** `task_goal`, `task_plan`, `task_status` and the check of done
  (ADR 0159) each hold one task. A second task either overwrites the plan or gets folded into it
  as extra items, and the check of done judges a mix of both.
- **No quick answer while busy.** "What time is it in Lisbon?" asked during a long task waits for
  the next model call in that turn. When that call comes it competes with the task for attention
  in the same prompt.
- **Context pressure.** Two tasks' tool results fill one context. Compaction then summarises both
  together, which is where details get dropped.

Spade already has two ways to run work outside the conversation. Neither fits a second request
from the person:

- **Helpers** (ADR 0152) have a fresh context and give one answer. They can't be messaged, have no
  goal or plan, can't ask the person anything (`ask_user` is left out) and are hidden. They are
  built for a part of the bot's own work, not for something the person asked for.
- **Workers** (ADR 0161) are long-lived bots with their own goals and plans, and they report back
  to their maker. But each one is a new bot: its own workspace folder, notes and listing in the
  person's bot list, and grants copied at creation. "Also send Dana the invoice" should not create
  a bot named "Invoice sender" in the person's sidebar, with a folder that can't see the invoice
  the first task just wrote.

## Decision drivers

1. Nothing the person asked for is lost or silently merged (priority 1, and the owner's report).
2. The person can always talk to the bot. A new message gets a reply in seconds, not after the
   current task.
3. Each task can be seen, steered, stopped and checked done on its own.
4. Restarts, compactions and pauses leave every task where it was (priority 2).
5. Reuse what is built: the worker tree, helpers' conversation ownership, the asks ledger, goals.
6. Spend is shown per task and never capped (ADR 0166).

## Options

### Option A: task lanes inside the bot (recommended)

A **lane** is one task the bot runs as a conversation of its own, beside its main conversation.
To the person it is a task; in code it is a lane, so it doesn't collide with `task_status`. A
lane is the bot doing the work, not another bot. It shares the bot's workspace folder, notes,
skills, connectors, plugins, settings, models and spend, as a helper does (`agent_for_conversation`
answers the bot). It also has what a helper lacks: its own goal, plan, `task_status`, check of
done, asks-ledger slice, and a transcript the person can open and write in. It joins the ADR 0161
tree as a third kind of worker, `lane`, so it rolls up, reports, queues and stops through the same
machinery.

The main conversation becomes the place where the person talks to the bot. It answers quick
things itself and starts anything longer as a lane. It routes follow-ups to the lane they belong
to, and tells the person when each lane finishes, fails or needs them.

- Pros: one bot, one folder, one memory, so the person's model of "my bot" holds. The main chat
  stays free. Each task has its own context, goal and check. Most of the parts exist already: the
  tree, reports, rollup, Stop, queueing, the helper conversation model and goals per conversation.
- Cons: tasks that share a folder can edit the same file. It adds a routing decision to every
  message, which the model can get wrong. It adds a third kind of worker to explain, and a
  transcript per task in the app.

### Option B: every second task becomes a worker bot

Keep the one-conversation model. When a request arrives that is independent of the running work,
the bot calls `bot_create` (ADR 0161) for it, and the worker reports back. That needs one new rule
in the system prompt and one guard: a person's message never just steers when it is a new task.

- Pros: almost nothing new to build. Workers already have goals, reports, rollup, Stop and
  queueing. Clean isolation: separate folders mean no file clashes.
- Cons: every errand becomes a bot in the person's list and lives on until someone deletes it.
  The worker can't see files the bot made, so the brief has to copy them, or the work happens in
  the wrong folder. Notes the worker saves are its own, so the bot doesn't learn from them.
  Grants are copied once and drift. The person's words reach the worker only as the maker's brief
  (`from_agent`, possibly untrusted), so its reviewer sees a bot's request, not the person's
  (ADR 0161 decision 7). The main conversation still runs the first task itself, so the "quick
  answer while busy" problem stays.

### Baseline both build on: the asks ledger alone

The ledger stops asks from being forgotten: an ask stays open until the bot closes it, and a
reply can't end with one open. It doesn't stop two jobs from sharing one context, and it doesn't
run them side by side. Both options assume it; neither replaces it.

## Decision (Option A)

### 1. The main conversation answers, routes and reports

The bot's own conversation stays as it is (`GET /v1/conversations` lists it, the person writes
there, approvals and questions show there). What changes is what it is told to do. Its turns
should be short: answer, decide, start or message lanes, and report. Work that will take more than
a few steps runs in a lane. When the main conversation does work itself, the work is the main
conversation's own task, with its own `task_status` and goal as today, so a bot that never starts
a lane behaves exactly as it does now.

### 2. How a new request is placed

Each person's message opens an asks-ledger entry. The main model places each entry in one of
three ways, recorded on the entry:

| Placement | When                                                                     | What happens                                                                             |
| --------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| answer    | a question, a lookup or a one-step action                                | main answers it and closes the entry                                                     |
| fold      | it changes a task under way ("use March", "also cc Dana", "stop at two") | `task_message` sends it to that lane, or main's own task takes it; the entry moves there |
| start     | independent work that will take more than a few steps                    | `task_start` opens a lane and the entry moves to it                                      |

Deterministic routes come before the model:

- **A reply to a lane's message goes to that lane.** `reply_to` on a message that came from a
  lane, either its report in main or one of its own messages, sends the person's message straight
  to the lane. It is stored in main as the person's bubble with a quiet "Sent to _task_" line, and
  in the lane as the person's message (trusted, not `from_agent`). No model call decides it.
- **A message written in a lane's transcript belongs to that lane.** It steers that lane, as
  steering works today.
- **A message to main while main's own reply is open** is stored and seen at the next model call,
  as now, but marked `<new_ask id="a7" from="spade">`. The note tells the model to place it before
  going on with its current work. With the ledger's stop check, the turn can't end until the
  entry is placed and, if it was answered, closed. Main's turns are short (below), so this is the
  rare case.
- **Main's own work that runs long moves to a lane by itself.** Spade decides this, not the model.
  When a main reply has taken eight steps or run two minutes, Spade moves it to a lane at the next
  step boundary where no approval or question waits (2a).

### 2a. Moving main's long work to a lane

The owner chose (2026-11-22) that Spade moves the work without asking the model first. At the
boundary:

- Spade opens a lane for the asks main's open reply owns. Its title comes from the `title` role,
  in the person's words. Its conversation begins with `lane_of {moved_from: reply}`, then the recent
  chat as quoted context (the person's and the bot's messages since the last compaction, at most
  the last ten, no tool output), then the person's ask verbatim, then the reply's steps so far,
  copied as they were stored. The lane goes on from the step it was at, with the work's context
  intact.
- Background jobs, helpers, workers and wakes that the reply started now belong to the lane
  (`lane_moved {reply, lane, jobs, wakes}` in main, in the same write), so their results reach the
  lane and not main.
- Main's reply closes as `reply_moved {lane}`, and Spade writes one plain line in the chat, not the
  model: "This is taking a while, so I moved it to its own task: _Fix the March invoice_. I'm free
  to talk." The line opens the lane. Main's stop check reads the moved asks as the lane's.
- The move is stored in one write under the record lock that Stop and steering use, so a Stop or a
  message that comes at the same moment lands either before the move, in main, or after it, in the
  lane. It is never lost. After a restart, a move whose write landed is complete, and one that
  didn't land never happened.
- A lane's own work never moves: lanes are the end of the line.

The model places messages, not a separate classifier, because only the conversation knows
whether "and the PDF too" belongs to the invoice task. A wrong placement can be fixed: the person
says "that's separate" or "that was for the invoice", and main moves the entry
(`task_message`, or `task_start` with the entry).

### 3. Lanes

- **Tools, offered to the main conversation as core tools** (they are part of every bot's job
  now, so they are not deferred). They are left out of lanes and helpers:

  | Tool           | Effect        | Arguments                                 | Answers                                                |
  | -------------- | ------------- | ----------------------------------------- | ------------------------------------------------------ |
  | `task_start`   | `write_local` | `title`, `brief`, `asks[]`                | `{task, title, state: working \| queued}`              |
  | `task_message` | `write_local` | `task`, `text`, `asks?[]`                 | `{task, state}`                                        |
  | `task_stop`    | `write_local` | `task`, `because` (a person's message id) | `{task, state: stopped}`                               |
  | `tasks`        | `read`        | `task?`                                   | each lane's title, state, goal, plan, last words, cost |

  `task_stop` is refused unless `because` names a person's message in main that asks for the stop
  (or supersedes the task: "never mind the invoice"). The bot never cancels the person's task on
  its own judgment. A lane that is stuck says so in its report, and the person decides.

- **A lane's conversation.** It is hidden from `GET /v1/conversations`, as a helper's is, but the
  person can message it (`POST …/messages` answers `202`, not helpers' `409`). It starts with
  `lane_of {parent_conversation, call, title, asks[], untrusted}`, then one `user_message` that
  quotes the person's own words for each moved ask verbatim. That message is the person's, so the
  lane's reviewer reads the person's request and not a bot's. Main's brief follows it as
  `<task_brief from="bot">`, marked untrusted when main had untrusted content in view as it wrote
  it (ADR 0161's `worker_of.untrusted` rule). Its system prompt is the bot's: the same rules,
  skill index, notes index and plugin rules, plus the lane section below. A lane's prompt top
  therefore matches the bot's, and it is cached once per bot, not once per lane.
- **Its own task.** `task_goal`, `task_plan`, `task_status`, the continuation (`task::next`) and
  the check of done all work per conversation already, so each lane has its own without new rules.
  A lane's `done` passes only through its own check (ADR 0159).
- **Its own ledger slice.** The entries moved to it are its open asks. Its stop check reads only
  those. Main's stop check skips entries a lane owns, and main's prompt shows them as "with task
  _title_".
- **Its own terminal session**, as a helper has one (`computer.md`), so two lanes' shell commands
  run side by side and don't queue behind each other.
- **Shared folder, overlap noted.** Lanes write to the bot's one folder. The engine already knows
  which paths each call named. When a lane writes a path another lane that is still working wrote,
  the writing lane's next prompt gets `<overlap task="…" path="…" from="spade">`, and main gets the
  same note in that lane's next report. It is a note, not a lock: locks across long tasks deadlock,
  and most overlaps are intended (one task writes the file, the next sends it). The system prompt
  says to keep work that touches the same files in one task.
- **Its model** is the new `task` role (8a), so the person can run tasks on a different model from
  the chat.
- **What it may start.** A lane may use helpers, `bot_create` and ace's `delegate` as main can, so
  its workers hang under it in the tree. It may not start lanes: one level keeps the task list
  flat and keeps routing in one place.

### 4. Reports and progress

- **Reports are ADR 0161 reports.** When a lane settles, `worker_reported {kind: lane, state,
epoch, summary, words}` is stored once in main, with the states `done`, `finished`,
  `needs_you`, `failed` and `stopped`. It opens a short main reply, and the bot tells the person in
  its own words: what was done, with the evidence the check accepted. That message carries the
  lane's id, so a reply to it routes to the lane (2). A `stopped` report opens no reply, as today.
- **Progress doesn't open main replies.** A plan checkpoint in a lane doesn't wake main: that
  would spend a model call for every item and fill main's context. The app reads progress from the
  lane's own events (7). When the person asks "how's it going?", main calls `tasks` and answers.
  A lane that runs long sends no extra check-ins; its row's running time and plan step say how it
  is doing.
- **Asking the person.** A lane's approvals and `ask_user` cards are stored in the lane and also
  in main in the same write, as helpers' approvals are (`approval_requested {lane: {conversation,
call_id}}`, and the same for `question_asked`). The person answers from main's request strip
  without opening the lane, and Spade stores the answer in both. "Always" lands in main, so it
  holds for the bot and all its lanes.

### 5. Finish, failure, stop, reopening

- A lane **ends** when its reply ends and its task won't carry on: `done` (check passed),
  `finished` (no verified goal), or `failed`. An ended lane keeps its transcript. When the person
  writes in it, or main sends it a `task_message`, it opens a new reply (a new epoch), so the task
  can be taken up again in its own context.
- **Failure** is reported (4). Its row offers Try again, the conversation's Try again (`chat-core.md`) on the
  lane's last reply.
- **Stop** on a lane's row, or `task_stop`, stops that lane and its subtree, as `worker_stop`
  does. Stop on the bot stops main and every lane. Pause (ADR 0200 §6) pauses every lane with the
  bot.
- **Ended lanes** leave the live list once the person has seen their report. They stay in
  `tasks` and in history search, and the person can open them from the line where they started.

### 6. Restarts, compaction, moves

- **The links are events**, written as `lane_started {lane, conversation, title, call, asks}` in
  main and `lane_of` in the lane, and folded by `Store::worker_links` with the other worker kinds.
  A `task_start` that runs again after a restart finds its lane by the call key, so it never makes
  two.
- **A lane's turn resumes as a helper's does.** Cut off mid-step, its next step is asked for again;
  a tool cut off mid-run gets "unknown outcome". Only a lane the person stopped is closed at
  start. Every lane is checked for owed reports when Spade opens, so a report owed from before the
  restart arrives once.
- **Compaction is per conversation.** A lane compacts its own context with its own summary, so
  one task's results never crowd out another's. Main's compaction lists every lane that hasn't
  ended, read from the events and not from the summary, the way `carried` lists writes: one line
  each, with title, id, state and the asks it owns. After a compaction main's instructions end with
  that list, as the goal view is pinned (ADR 0159), so the prompt top changes only at compactions.
  Lane reports in main age like tool results under the context budget. The report's facts stay in
  the lane, and `tasks` reads them again.
- **Moves** (ADR 0187) carry a bot's lanes with it, as they carry its conversations. A lane that
  is working when the move freezes the bot pauses and resumes on the target.

### 7. What the person sees

This follows [the design language](../design/design-language.md): state, not chrome; words, not
chrome; one place per fact. It describes the design only, with no UI code.

- **In main's transcript**, where main starts a lane, one quiet line in Spade's words: "Started a
  task: _Fix the March invoice_". While the lane runs, that line carries its step and count
  ("· 2 of 5 · Drafting the email to Dana"); once it ends, the line is the record. When the lane reports, the bot's own message says what happened,
  followed by one quiet line: "Task done: _Fix the March invoice_". It reads "Task stopped early"
  or "Task stopped" for the other endings. Either line opens the lane. A person's message routed
  by a reply carries "Sent to _Fix the March invoice_" under its bubble. There are no task cards
  in the transcript.
- **The tasks pill.** Main's own status pill shows only while main itself works
  ("Working · 12s"). One more pill, beside the bot's pill at the top of the conversation, names the
  lanes: "2 tasks", or "2 tasks · 1 needs you". It opens the task list. While lanes are live the pill names them and the transcript lines are the record;
  this is the rule the design language already sets for subagents.
- **Main's moved work** reads as the plain line Spade writes (2a), "This is taking a while, so I
  moved it to its own task: _title_. I'm free to talk.", in the same quiet style as the started
  line, and it opens the lane.
- **The task list** is a sheet on the iPhone, and on desktop and web a popover from the tasks pill
  (the owner's pick, 2026-11-23, from the prototype's screenshot 01). A panel beside the chat was
  also mocked and not chosen. The list is one flat list
  ordered by needs you, then running, then finished unseen, then queued. Each row has a still
  status icon and a running time, the title (full ink when the person is needed), and one quieter
  line: the current plan step and count ("2 of 5 · Drafting the email"), or "Queued", or the
  report's first line once it has ended. The cost sits on the trailing edge in the quietest ink.
  There are no badges, no tints and no section labels. A row's actions are text: Stop, and Try
  again on a failed one.
- **A lane's transcript** opens from a row or a line as the same transcript view a conversation
  uses, titled with the task and with the bot named under it. It has its own composer, and
  writing there steers that task. Stop in that composer stops that task only. Its goal strip is
  the goal strip a conversation has today.
- **Requests.** A lane's approval or question waits in main's request strip, leading with the
  task: "_Fix the March invoice_ wants to send an email to dana@…", with the strip's usual buttons.
  Several waiting read "1 of 3", as now.
- **The bot's row** in the sidebar and roster rolls up as ADR 0161 already rolls up workers. It
  reads working while any lane works, needs you while any lane waits on the person, and is never
  idle while a lane runs. The roster adds `tasks`, the count of lanes that haven't ended.

### 8. Limits and spend

- At most `SPADE_TASKS_AT_ONCE` lanes of a bot have a reply open at once, default 16 (the owner,
  2026-11-22), the same as helpers. It is a setting, not a rule (ADR 0158). A `task_start`, or a
  move of main's work, past that is stored queued and starts oldest first. Main says so ("Queued
  behind 16 running tasks"), and the row reads "Queued".
- Spend is recorded per lane (`cost_micros` on its tree node, and the `task` role under the bot)
  and summed into the bot's spend. The task list shows each lane's cost, and nothing stops on it
  (ADR 0166).
- One shared prompt top keeps the price of running lanes down: their system prompts match main's
  byte for byte, so the provider's cache serves them all.

### 8a. The `task` model role

A lane's steps run on a new routing role, `task`, beside `main`, `helper`, `review`, `verify`,
`compact` and `title` (ADR 0162). It resolves like the others: the bot's override, else the global
one, else the default, which is whatever the bot's `main` role resolves to. Its thinking effort
(ADR 0213) resolves the same way, with a default of whatever `main`'s effort resolves to. A person
who never touches it gets tasks on the chat's model and effort, and changing main changes tasks
too. Both are stored in the same `model_roles` settings and read and set through
`/v1/models/roles` and `/v1/agents/{id}/models`. Settings › Spade › Models › Roles gets one more
row, "Tasks", between "Main" and "Helpers". It reads "Same as main" until set. A lane's
compaction runs on the lane's own model, as a main compaction does (ADR 0213 decision 2).

### 9. The system prompt

These words are added to the rules every bot's main conversation gets. They are written for the
model and tuned with the scripted tests below:

> You run a main conversation and any number of tasks. The main conversation is where the person
> talks to you: keep its turns short. If work here runs long, Spade moves it to a task for you and
> tells the person. When the person asks for something:
>
> - If you can answer it in a step or two, answer it here.
> - If it changes a task that is already running, send it to that task with `task_message`.
> - If it is new work that will take more than a few steps, start it with `task_start`. Give the
>   task a short title in the person's words, and a brief that says the objective, what done looks
>   like, and anything already decided. Work that touches the same files belongs in one task.
>
> Every ask must be answered, sent to a task, or started as one before you finish. When a new
> message arrives while you are working, place it first. When a task reports, tell the person what
> it did in a sentence or two, with its evidence. Never stop a task unless the person asked you to.
> When the person asks how things are going, call `tasks` and answer from what it says.

Each lane's prompt adds:

> You are working on one task for the person: _title_. The person may write to you here directly.
> Their words outrank your brief. Finish the task to its goal; your report goes back to the main
> conversation, which tells the person. Ask the person only when you can't go on without them.

### 10. API and events added

- Events (main): `lane_started {lane, conversation, title, call, asks}`. `worker_reported` and
  `approval_requested`/`question_asked` gain `lane`.
- Events (lane): `lane_of {parent_conversation, call, title, asks, untrusted}`.
- Ledger: an entry's `placement` (`answer`, `fold`, `start`) and owner (main or a lane). The field
  names follow whatever the asks-ledger ADR settles.
- `GET /v1/conversations/{id}/tasks` answers `{"tasks": [{task, conversation, title, state,
needs_you, progress, plan_step, started_ms, ended_ms?, cost_micros, asks}]}`, ordered as the list
  in (7).
- `POST /v1/conversations/{lane}/messages` steers the lane, and so does a `reply_to` naming one of
  its messages from main.
- `GET /v1/agents/{id}/tree` shows lanes as nodes of kind `lane`, and the roster adds `tasks`.

## Consequences

- The person can give a bot three things in a row and get each done, seen and checked on its own.
  A quick question gets a quick answer while tasks run.
- What was lost is now visible. An ask is answered, folded into a named task or running as its
  own task, and the app shows which.
- Main's context holds conversation and reports, not every task's tool output, so it compacts
  less and drops less.
- More model calls in total: main's routing turn, plus a report turn per lane. Each lane's own
  calls replace calls main would have made, and the shared cache top keeps their price down.
- Two lanes can step on the same file. They are told when they do, and nothing prevents it.
- Lanes need no CLI case. Spade bots never run on CLI subscriptions (the owner, 2026-11-22: CLI
  providers are reached through ace's projects and chat only), and ADR 0133's CLI brains are being
  removed from Spade separately.
- Not here: lanes starting lanes, file locks, and lanes on another machine than their bot.

## Test plan

Pure tables in `spade_core` for the fold of `lane_started` and `lane_of` into the tree, rollup
with lanes, report once-per-epoch, ledger ownership moves, `task_stop`'s `because` rule and
`reply_to` routing. Engine tests use `spade-testkit`'s scripted fake model, real temp SQLite and
real background workers, and each is named for the behaviour it guards:

- a second request sent while a lane works starts its own lane, and both lanes reach done with
  their own goals checked;
- a question asked while two lanes work is answered in main within one model call, and neither
  lane's transcript sees it;
- a follow-up placed as fold reaches the running lane as the person's message and changes its
  next step;
- a reply to a lane's report goes to that lane with no main model call;
- main can't end its reply while a new ask is unplaced (ledger stop check with lanes);
- an ask moved to a lane keeps main's stop check clear, and a lane can't end with its own asks
  open;
- a lane's approval shows in main, is answered there, and wakes the lane; "always" holds for a
  second lane;
- the bot reads working while any lane works, needs you while any lane waits, and never done while
  a lane runs;
- a lane that settles reports once, also when Spade restarts between the settle and the report;
- a `task_start` run again after a restart finds its lane and doesn't make a second one;
- a main reply that reaches eight steps moves to a lane at the next boundary, the lane carries on
  from the same step with the same calls' results, main posts the moved line, and a job the reply
  started delivers its result to the lane;
- a main reply waiting on an approval when it reaches the threshold moves only after the answer;
- a message sent at the moment of a move lands exactly once, in main or in the lane;
- a lane's steps run on the `task` role's model and effort, and on main's when the role is unset;
- a lane cut off mid-step by a restart resumes its next step;
- `task_stop` with no `because`, or with one naming a bot message, is refused;
- Stop on a lane stops only that lane and its helpers; Stop on the bot stops all lanes;
- the seventeenth lane is queued (16 run at once) and starts when one ends;
- main's compaction lists every lane that hasn't ended, from events, and the model reads them
  after it;
- a lane writing a path another working lane wrote gets the overlap note;
- the person's words in a lane's first message are trusted, and a brief written with untrusted
  content in view taints the lane's writes.

## Build notes

From the prototype (`ace/spade-lanes-prototype`, PR #2668):

- **The popover is solid.** The prototype's popover used the glass material, and the chat showed
  through behind its rows. The task list uses the solid popover surface that ace's other content
  popovers use.
- **Requests read plainly.** The prototype's payment request read "wants to send payment to TAP
  Air Portugal", because the words came from the tool's name. A lane's request is worded from
  what the call does, as any request should be: "_Book flights to Lisbon_ wants to pay €412 to TAP
  Air Portugal".

## Questions the owner resolved (2026-11-22)

1. **Default limit:** 16 lanes at once per bot (8).
2. **Model per lane:** a new `task` role in model settings, resolved like the others, with its own
   effort; the default is the bot's main model (8a).
3. **Main's long work:** Spade moves it to a lane automatically, with no suggestion step, and says
   so plainly in the chat (2a).
4. **CLI brains:** none. Spade bots never run on CLI subscriptions; lanes have no CLI case. Spade's
   own ChatGPT sign-in is not a CLI subscription and is unaffected.
5. **Where the task list lives on desktop:** a popover from the tasks pill beside the bot's pill
   (2026-11-23, chosen from the mockups built in the real web app on fake data). The panel beside
   the chat was considered and not chosen.

## As built (2026-11-23)

The engine is in `spade/crates/spade-server/src/engine/lanes/`, the rules in `spade_core::lane`,
and the build is described in [spade/docs/workers.md](../../spade/docs/workers.md) ("Lanes").
Where it differs from the text above:

- **Storage.** Besides the `lane_of` and `lane_started` events, a lane has a `helpers` row with
  profile `lane`. The row makes it a hidden conversation of its bot for everything that already
  asks (whose workspace, spend and settings it uses, the conversation list, moves, deletion)
  without a new table or a scan of the events.
- **One event for the move.** `lane_moved` and `reply_moved` are one event, `reply_moved {reply,
lane, title, asks}`, followed by the reply's close as `reply_finished` with no text, in the
  same write as the lane. The app writes Spade's plain line from it.
- **What moves.** The reply's background jobs and its open wakes move with it, in the same write:
  `reply_moved` lists them (`jobs`, `wakes`), main closes the wakes (`wake_cancelled {by:
moved}`), and a running job's live handle moves to the lane under the lock a job takes to
  store its end, so it reports exactly once, to main before the move or to the lane after it.
  A helper's row moves to the lane; its requests still show in main, as the lane's. Two kinds
  stay with main, listed as `kept_jobs`: ace's `delegate` and `wait` (main's events track the ace
  children, their Stop and their reattachment after a restart) and contract calls (the callee
  answers main's call, and its Stop and delivery are keyed to main). Moving those would leave
  main reading a child or callee that is no longer its, or a lane waiting on a result keyed to
  main. The lane reads a closing note for each kept job, and main's `<moved>` note asks main to
  send the lane what it needs when the result comes. A job already storing its result when the
  move lands stays too.
- **Titles.** A lane `task_start` opens keeps the title main gave it. A moved lane runs under the
  person's first line at once; a background call to the `title` role then names it
  (`lane_titled {lane, title}` in main and the lane). A failed call keeps the first line.
- **Main's tasks block** closes every step's prompt after the `<asks>` block while lanes haven't
  ended, rather than being pinned after compactions.
- **A lane's prompt.** Its system prompt and offered tools are main's byte for byte; what it is
  told about its task sits in its first message's context. A lane's call to a lane tool is refused.
- **Questions** are asked in main as approvals are: `question_asked.lane`, call id
  `<lane>.<call>`, answered in main and sent to the lane's card; an answer given in the lane
  closes main's copy.
- **Overlaps** are noted as `lanes_overlapped {lane, title, path, other, other_title}` in the
  writing lane and in main, from the paths of `workspace_write`, `workspace_edit` and a job's
  kept files. A shell command's writes are not seen.
- **A lane's goal** reads at `GET /v1/conversations/{lane}/task`, the body `GET
/v1/agents/{id}/task` answers.
- **Not built here:** the UI (a separate thread builds the popover, the lines and the pill against
  `GET /v1/conversations/{id}/tasks` and the events).
