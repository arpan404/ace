# Autonomy: the auto-review, tasks that keep going

Date: 2026-11-13, amended 2026-11-15. As built for
[ADR 0144](../../docs/adr/0144-spade-autonomous-bots.md) and
[ADR 0163](../../docs/adr/0163-spade-auto-review-only.md) (one level). Extends
[harness.md](harness.md), [workspace.md](workspace.md), [oversight.md](oversight.md) and
[agents.md](agents.md). The pure rules are `spade_core::autonomy` and `spade_core::task`; the
engine side is `engine/autonomy.rs`, `engine/calls.rs` and `engine/continuation.rs`.

## One level: the auto-review

Every bot is on the auto-review (ADR 0163). A call the rule gate would ask about goes to the
reviewer; calls the rule gate runs (reads, notes in a clean turn, writes allowed always) run,
and the ADR 0135 review still checks those when it is switched on.

- Old `{"type":"access_changed","level"}` events read as `auto_review`, whatever level they name.
  Once, on its first start, this build appends an `access_changed` to `auto_review` to each
  conversation whose latest stored level is `ask` or `full_access` (`Store::latest_field`), then
  stores the setting `access_levels_retired` and removes `access_levels_pinned`.
- Nothing else stores a level: creating or changing a bot never writes one.

### What the reviewer is told

Kinds that used to always go to the person are reviewed, with the rule's line in `<concern>`
(`Sensitive::reason`, e.g. "It could spend money."):

| Kind            | How it is recognised                                                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| payment         | `pay`, `purchase`, `buy`, `checkout`, `charge`, `order`, `transfer`…                                                                                                       |
| credentials     | `password`, `token`, `key`, `permission`, `role`, `invite`, `access`…                                                                                                      |
| message as you  | `send`, `reply`, `forward`, `email`, `message`, `dm`, `chat`…                                                                                                              |
| publish         | `post`, `publish`, `share`, `comment`, `deploy`, `merge`, `upload`…                                                                                                        |
| delete outside  | `delete`, `remove`, `trash`…, or `destructiveHint` / destructive risk                                                                                                      |
| unknown         | a tool of Spade's not in its table, or an app tool with no annotations                                                                                                     |
| mislabelled     | an app tool marked read-only whose name, or its description's first word, acts (`send`, `post`, `delete`, `create`, `transfer`…); reviewed though the rule gate runs reads |
| tainted outward | an ace or app tool that matches nothing above, while untrusted content is in view                                                                                          |
| tainted routine | `routine_save` / `routine_delete` while untrusted content is in view, reviewed even when allowed always                                                                    |
| shell           | what the shell classifier below finds                                                                                                                                      |

Two kinds go to the person without a review, since the reviewer can't read them whole; their
`call_reviewed` is stored with `model: ""` and the bubble's `reviewer_reason` says why:

- **too long:** arguments over 32,000 characters of JSON, or shown files over 48,000;
- **unseen script:** a script outside the folder, unreadable or too long to show.

Words come from the tool's name (split on `_`, `-`, `.` and camelCase), then the first three
words of an app tool's description. An app's annotations are hints from a server Spade doesn't
control: the name and description checks run before a read-only claim counts. Spade's tools that
stay inside the bot (`workspace_*`, `memory_*`, `todo`, `task_status`, `skill_*`, `routine_*`,
`image_generate`, `share_file`) and those that reach another bot (`bot_message`, `group_ask`) go
to the reviewer. ace's tools and app tools that match nothing go to the reviewer, told when
untrusted content is in view.

### The shell classifier

**What it is, and what it isn't.** The classifier is a best-effort layer in front of the reviewer.
It catches common ways a command reaches outside the workspace and names them to the reviewer as
its concern. It is not a containment guarantee: a shell can do more than any
reading of its words can follow, and a command it lets through can still reach the network or
write outside the workspace. Containment will come from an OS sandbox in a later change: no
network, and writes only in the workspace and temp folders, unless the reviewer or the person
approves an unsandboxed run. Until then, `auto_review` relies on the reviewer for what the
classifier misses.

When it can't follow what a command will run, it doesn't try harder: it sends the command to the
person as unclear.

`spade_core::autonomy::shell` reads a `shell` command without a model and sends these to the
person whatever the reviewer would say (the reason names the kind):

| Kind          | Commands                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| network       | `curl` with `-d`/`--data*`/`-F`/`-T`/`--upload-file`/`--json`/`-X POST\|PUT\|PATCH\|DELETE`, attached (`-XPOST`, `-Ffile=@x`, `--data=x`) or in a cluster (`-sSd x`); `wget --post-*` (any unambiguous start, `--post-d`)/`--method`; inline code naming the network (`urllib`, `requests`, `fetch`, `http`, `socket`…); `http`/`xh` with a method or fields; `nc`, `socat`, `telnet`, `ssh`, `ftp`, `sftp`; `scp`/`rsync` to a remote; `/dev/tcp/` or `/dev/udp/` anywhere in the command; `npx`, `npm exec`, `pnpm dlx`, `yarn dlx`, `bunx` of a package not in `node_modules/.bin`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| mail          | `mail`, `sendmail`, `mutt`, `msmtp`, `swaks`, `git send-email`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| publish       | `git push`; `gh pr\|issue\|release… create\|merge\|edit…`, `gh api` writes (`-f`/`-F` attached or not, `--field=`, `--input`, `-XPOST`); `npm\|cargo\|twine\|gem… publish\|upload`; `docker push`; `vercel`/`netlify`… deploys                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| server change | `kubectl apply\|delete…`, `helm install…`, `terraform apply\|destroy`, cloud CLIs' writes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| outside       | `rm`, `mv`, `cp`, `tee`, `dd`, redirects, `find -delete`/`-exec` whose real path, from the terminal's current folder with symlinked folders followed, is outside the workspace or can't be resolved; `~` or a variable; `ln -s` pointing outside                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| other apps    | `osascript`, `open`, `xdotool`, `shortcuts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| admin         | `sudo`, `su`, `launchctl`, `systemctl`, `crontab`, `diskutil`…                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| payment       | `stripe`, `paypal`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| unclear       | what it can't read: here-documents, `eval`, backticks, `$((…))`, a program from a variable, a shell reading from a pipe (`base64 -d \| sh`), unbalanced quotes, `curl -K`/`--config`, `wget -e`, `parallel` reading commands from its input; `xargs` or `find -exec` handing a shell or interpreter text from its input (`xargs sh -c '{}'`, `sh -c '{}'`); a file the same command writes, downloads or may rewrite (`cp`, `curl -o`, `wget`, `sed -i`, `tar x`, `unzip`, `git pull`/`checkout`…) and also runs; a `cd` to somewhere it can't resolve (`cd`, `cd -`, `cd $X`, `popd`); a git alias (a first word git doesn't have) or a command given as git configuration (`-c core.hooksPath=`, `-c alias.`); hooks moved elsewhere (`core.hooksPath` in the repository's config) or a `.git` that is a file; `make -e`/`--eval`, and in the selected goals `$(shell)`, `$(eval)`, `$(call)` or `!=`; another shell or language in a justfile recipe; inline code that starts programs or builds code (`subprocess`, `child_process`, `os.system`, `eval(`, `base64`, awk's `system()` and pipes) |
| unseen script | a file the command runs that Spade can't show: outside the workspace, through `~` or a variable, missing, unreadable (a binary), or over 24,000 bytes; a makefile `include` that is missing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

It tries to read every simple command: across `|`, `;`, `&&`, `||`, `$(…)`, `sh -c`/`bash -c` strings,
variable assignments and wrappers. What a wrapper runs (`find -exec`/`-execdir`/`-ok`, `xargs`,
`parallel`, `timeout`, `nice`, `nohup`, `time`, `watch`, `command`, `builtin`, `exec`, `env`
and `env -S`, `flock`, `sudo`, `doas`, `su -c`…) is unwrapped through the same reading, and each
command gets both the credential and the effect checks. A command with no `command` argument is
unclear. Anything it passes still goes to the reviewer.

Inline code (`python -c`, `node -e`, `perl -e`, `ruby -e`, `php -r`, an awk program) is in the
call, so the reviewer reads it, told of any marker above as its concern.

**Scripts.** A command that runs a file is judged by the file: `./x.sh`, `bin/x`, `sh x.sh`,
`source x` and `. x` (any name), `sh < x` and `bash -s < x`, `python x.py` (and `python < x`),
`node x.js` (and `-r` preloads), `ruby`, `perl`, `go run`, `tsx`, `deno run`, package scripts
(`npm|pnpm run|run-script|rum|test|t|tst|start…`, `yarn <script>`, `bun run`: the `pre`, main and
`post` entries of `package.json`), the repository's git hooks for a git command that runs them
(`commit`, `merge`, `pull`, `push`, `rebase`, `am`, `checkout`, `switch`, `cherry-pick`…: every
hook not ending in `.sample`), `make` and `just`. The reviewer is shown each file whole in
`<runs>`. Shell scripts (by `#!` line, or with none), recipe lines, package scripts and
hooks are also checked like commands, and what they find counts. Another kind of script that
starts programs or builds code (`subprocess`, `child_process`, `os.system`, `eval(`…) is
unclear, since what it runs isn't shown. A file that names a credential place is refused.

`make` reads the makefile (`-f`, else `GNUmakefile`, `makefile`, `Makefile`; `-C` honoured), the
files it `include`s, and only the goals asked for (or the default goal) with what they depend on:
explicit and pattern rules, variables and automatic variables expanded, command-line `VAR=x`
honoured. A `deploy` target beside `test` doesn't make `make test` ask. `just` does the same for
the recipes asked for (or the first) and their dependencies.

**Folders.** A command's folder follows `cd x &&` and `cd x;` (until the subshell it is in ends),
`env -C`, `git -C`, `make -C`, `npm --prefix`, `pnpm -C`/`--dir` and `yarn --cwd`, from the
terminal's current folder.

**Bounds.** One classification reads at most 64 files, 2 MB of them and 2 MB of command text,
follows prerequisite chains 64 deep and 4,096 targets, and expands at most 1 MB of make text;
past any of these the rest is unclear. It runs off the turn's thread, with 10 seconds before it
is unclear, and Stop is heard meanwhile. A makefile that fails to read in one place is still read
everywhere else, and recipes that don't expand are checked as written.

**Precedence.** Everything a command reaches is read before deciding: a credential read found
anywhere (the command, a nested command, a script it runs) is refused before any other finding
(`sudo sh keys.sh` is refused even when allowed always). Of the rest, the first named kind is the reason,
over "unclear" or "unseen script". The approval is bound to the SHA-256 of what was shown
(`call_reviewed.bound`): if any file differs when the call is about to start, it isn't run and
the bot gets `Not run: A file it runs changed after it was reviewed.` Paths are resolved against
the terminal's current folder.

**Each command is a fresh `sh -c`.** A bot's commands carry only the folder and exported
variables from one to the next; shell functions and aliases never carry over (`BASH_FUNC_*`, a
value that is a function body), nor variables that make a shell or interpreter run code first
(`BASH_ENV`, `ENV`, `NODE_OPTIONS`, `PYTHONSTARTUP`, `PERL5OPT`, `RUBYOPT`, `GIT_SSH_COMMAND`,
`LESSOPEN`, `ZDOTDIR`…), so a definition from one command can't change what the next one's words
run.

### The reviewer

`review_model` from `/v1/oversight`, else the fast model, else the bot's own. Typed output:

```json
{ "verdict": "approve" | "refuse", "reason": "one sentence", "retries_refused": false }
```

- `approve` runs the call.
- `refuse` returns `Not run: <reason> Don't work around this. …` to the bot as the call's
  result, not an error, unless the bot is trying a refused step again (below).
- `retries_refused` (optional, default `false`): the step tries again what a step in
  `<refused_before>` tried. The reviewer is shown up to five steps refused since the person's
  latest message, each with its arguments (cut to 1,000 characters) and reason.
- It reads the call's arguments whole, never cut; a call too long for that goes to the person.
- It is told of every untrusted source still in the model's view: this turn's, an earlier
  turn's since the last compaction, or a summary drawn from one.
- Its cost counts toward the caps even when the provider sends no usage (a timeout, Stop, an
  error that may have billed): Spade settles an estimate from the prompt.
- Failure, a 60 s timeout, unparseable output (an `escalate` verdict included) or a cap: the person
  is asked, with the reason. An unreviewed call never runs.
- Status line while it reads: `Checking a step`.

### When the person is asked

A refusal goes to the person instead of the bot (`call_reviewed` verdict `escalate`,
`reviewer_reason` `Refused again: <reason>`) when, since the person's latest message
(`spade_core::autonomy::refusals`):

- a refused call had the same tool and arguments;
- the reviewer says `retries_refused` and something was refused; or
- it is the third refusal in a row (`IN_A_ROW`), with no call started, approved or answered
  between them.

Credential refusals are the rules' own (`model: ""`) and never count. Otherwise the person is
asked only when the review can't run or can't read the call whole (above). Their Allow, Always
allow or Decline answers the request as before; Always allow lets later calls of that tool and
scope run unreviewed.

### Credentials

For every call, reads included and whatever the person allowed always, a call is refused when any
string in its arguments names a place where sign-ins live (`~/.codex`, `~/.claude`,
`~/.claude.json`, `~/.config/gh/hosts.yml`, `~/.aws`, `~/.ssh`, `.netrc`, `~/.docker/config.json`,
`.npmrc`, `.pypirc`, `.git-credentials`, `~/.gnupg`, the keychain folders, `~/.kube/config`,
ace's account homes and token, Spade's database), whatever program reads it, or reads as a
command that reads secrets (`security find-*-password`/`dump-keychain`/`export`,
`secret-tool lookup`, `gpg --export-secret*`, `pass`, `op`, `bw`, `keyring get`, `gh auth`,
`git credential`…), across pipes, wrappers and `sh -c` strings (`spade_core::autonomy::secrets`),
or the tool itself says it hands back a secret: its name or its description's first sentence
names a token, secret, password, credential, passphrase, keychain, API key or private key, it
reads (read-only, or a verb like `get`, `read`, `fetch`, `show`, `export`, `return`), and no verb
says it changes them. A tool that changes sign-ins or access (`rotate`, `set`, `revoke`,
`create`…) goes to the reviewer instead, as a credentials concern:
`Not run: Spade never lets a bot read sign-in tokens, keys or provider credentials.` This is a
list of known places and tools, so it misses what it doesn't know; it is a guard rail in front of
the reviewer and the person, not a sandbox.

### Routines

A routine saved or changed by a bot while untrusted content is in view is reviewed with that
concern (above) and is marked `untrusted` for good (the `routines.untrusted` column). Routines that
existed before this column are untrusted unless the person made them (`created_by` is
`person`). Its firings carry
`from_routine.untrusted: true`, so the turn they start is tainted.

## Tasks that keep going

`task_status {status, note?}`: `working`, `waiting`, `blocked_on_person`, `done`. Risk read; the
latest valid call is the state.

When a reply ends finished, `spade_core::task::next(events, policy)` decides:

| Condition                                                   | Result                                     |
| ----------------------------------------------------------- | ------------------------------------------ |
| reply stopped, failed or cut off; Stop since; a job running | nothing                                    |
| an open wake (the bot sleeps or waits, ADR 0160)            | nothing: the wake is the next step         |
| task not `working`; already paused since the latest message | nothing                                    |
| the last 3 steps had no effect                              | pause (`no_progress`)                      |
| the last step had an effect                                 | continue now                               |
| the last _n_ steps had none                                 | continue after 30 s × 2ⁿ⁻¹, at most 15 min |

There is no step budget: a task that keeps doing something carries on for as many steps as it
needs ([ADR 0158](../../docs/adr/0158-spade-no-fixed-step-or-time-limits.md)). A `task_paused
{reason: budget}` stored by an earlier version still holds until the person writes.

An effect is a started call of risk write, destructive or memory, or a `todo` / `task_status`
call with arguments different from the one before it. The engine also starts nothing while
Spade is closing or the person has the bot's computer.

**At a spending cap the task waits** (ADR 0158): a step due while the bot (or the service) is at a
cap is not dropped. The task parks on a wake, `wake_set {purpose: {kind: park, reason: cap},
due_ms, reason}`, once; the bot reads as `sleeping` with `reason` as its status ("Porter is at
its daily cap of $1.00 until midnight. It carries on then, or as soon as the cap is raised.").
The wake fires at `due_ms` (the cap's reset: the person's next midnight, or the first of next
month), as soon as the person raises or removes the bot's cap, when Spade opens with the cap
lifted, or when the person wakes it; then the step is planned again (and parks again if a cap
still holds). A reply the service's cap ended (`reply_failed` of kind `cap`) carries the task on
the same way. Any message settles the park (the reply it opens meets the cap again if it still
holds); Stop cancels it. A `task_parked` stored by an earlier build is still read and ignored.

A continued step is stored as `task_continued {step, nudge}` followed by `reply_started`, in one
write. The model reads `nudge` (`<continue step="n">…</continue>`) as a note from Spade; CLI
brains get it as their next turn. The step's taint reaches back to the latest message. A pause is
`task_paused {reason, steps}`, stored once.

Only the person's message resets the pause; a bot's message or a routine's firing
carries on the task it belongs to. `task_state` on the roster and the continuation read the same
history: the latest valid `task_status`.

The turn's worker decides and registers the next step before it lets go of the conversation.
Stop reads what runs, calls off a waiting step and stores `stop_requested` under the one lock work
starts under, then signals the workers, so a Stop pressed at any point after a reply ends calls
the step off. A step waiting out its backoff waits on the engine's clock; Stop
on an idle bot with a step waiting stores `stop_requested` with no reply and calls the step off.

## Goals, plans and the check of done

[ADR 0159](../../docs/adr/0159-spade-goals-plans-and-verification.md). The rules are pure, in
`spade_core::goal` (`change`, `verify`, `view`); the engine answers the tools itself
(`engine/goals.rs`).

- `task_goal {title, criteria}` drafts the goal while none is open. Its `text` is the person's
  latest message (else the bot's task). Refused while a goal is open: only the person changes it.
- `task_plan {op, …}`: `add {text, parent?}`, `split {item, into}`, `start {item}`,
  `done {item, evidence}`, `blocked {item, reason}`. Spade numbers items (`1`, `2`, `2.1`).
  Evidence is `{kind: output, call}` (a finished call or job of this conversation, not a plan
  call), `{kind: file, path}` (a call here named the file) or `{kind: url, url}`.
- Events: `goal_set {goal, title, text, criteria, by, verifier?}`, `goal_cleared {goal}`,
  `plan_changed {goal, change}`, `plan_checkpoint {goal, item, done, total}` (with each `done`),
  `task_verified {goal, claim, verdict, criteria, rejected, missing, model, cost_micros}`.
- When a reply ends with the latest `task_status` `done`, a goal open and no job running,
  `verify::claim` decides: open or blocked items, an empty plan, or nothing changed since the
  last `not_yet` are answered `not_yet` without a model. Otherwise the verifier (the goal's
  `verifier`, else the review model) gets the goal, criteria, items and the evidence's stored
  results, quoted. `done` needs every criterion met and no item rejected. A check stopped by a
  spending cap parks the task on the cap like a step (above); one whose model fails in a way that
  may pass parks it on `wake_set {purpose: {kind: park, reason: check, attempt}}` with the same
  backoff as an outage (1, 2, 4 … minutes, at most an hour). Either way the task reads as
  `checking`, never done, and the claim is checked when the wake fires. A check that can't run
  otherwise (a refused request, the 60 s timeout) stores `unchecked`. Registered like a waiting
  step, so Stop calls it off. No claim is checked while a wake is open.
- `not_yet` reads as `working` for `task::next`; the next `task_continued` nudge appends a
  `<check>` with what's missing and a `<plan_next>` naming the item to resume. Plan calls count
  as an effect for the no-progress pause.
- After a compaction the instructions end with the goal and plan as they stood when it was
  stored (`view::pinned`), so the prompt top changes only at compactions.

## Sleeping, waiting, services and parked retries

[ADR 0160](../../docs/adr/0160-spade-wake-and-owned-services.md). All of it is events in the bot's
conversation; `spade_core::wake` and `spade_core::service` are the folds.

- `sleep_until {at | after, reason}` and `wait_for {condition, timeout?, reason}` store
  `wake_set {wake, purpose, due_ms?, condition?, reason}` and end the turn. Conditions (`kind`):
  `job`, `service_line {service, pattern}`, `service_exit`, `file {path}`, `url` (loopback only,
  polled 2 s doubling to 60 s), `thread` (an ace thread done, failed or needs the person),
  `bot_message {bot?}`, `person`. Both are core tools of risk read; `wake_cancel` is deferred.
- A wake fires once: `wake_fired {wake, cause, note?, data}` is stored under the record lock only
  while the wake is open. With a note the model reads `<wake id cause from="spade">` (with any
  `data` as untrusted `<wake_data>`), which steers an open turn or opens a reply. A job's end or a
  message that settles a wait is stored with it and adds no note. `wake_cancelled {wake, by}`:
  `person`, `bot` or `stop`. A wake (and a service) is admitted under the record lock: refused
  once the person stopped the reply or job asking for it, and a job wait refused once the job has
  ended. Stop sweeps wakes and services again after its marker, so none from the stopped work
  outlives it. A service wait names the service by name or id and is stored by name. Open wakes are armed from the events when Spade opens for work; one
  already due fires on the timer's first look. The timer looks at least once a minute.
- The roster state is `sleeping` while a wake is open and nothing else runs, and while the open
  turn waits out an outage with no job running; `status` says what for and until when; the
  agent's `wake` is the soonest open wake. A bot is never idle or done while any wake is open:
  `task::next` carries no task on and `verify::claim` checks no claim until it fires.
- One rule for work that failed in a way that may pass (ADR 0158): it waits 1, 2, 4 … minutes,
  at most an hour, longer when the endpoint asks (still at most an hour), with no attempt limit,
  and a refused key, a used-up quota or a refused request is reported and never waits. What waits
  depends on what failed:
  - a turn's model step: the turn waits out the outage on `{kind: outage, attempt, error}`
    holding its reply open, and sends the step again when it fires ([harness.md](harness.md),
    "Waiting out an outage"). The person's message ends the wait early;
  - a background job whose tool marks its failure transient (`ToolOutput::transient`:
    `web_fetch` on the network, `429` or `5xx`; an ace tool that did not run): parked on
    `{kind: retry, attempt, job, error}`, it stays running in the record (no "unknown outcome"
    after a restart, no check-ins while parked) and runs its call again at the wake, a
    `delegate` or `wait` by reattaching to ace's children. Cancelling the wake ends the job;
  - the check of done: parked on `{kind: park, reason: check}` (above).
    A `{kind: retry}` with no `job` was stored by an earlier build for a closed reply; it still
    fires once and opens a reply with its note.
- While a background job runs, `job_progress {job, name, check, minutes, tail}` is delivered at
  15, 30, 60 and 120 minutes, then every two hours; `tail` is a shell job's terminal output.
- `service_start {name, command, cwd?, keep?}` (gated like `shell`), `service_status`,
  `service_logs {name, lines?, after?}`, `service_stop`, all deferred. Events `service_started
{service, name, command, cwd, keep, restarts?}` and `service_ended {service, cause, code?}`
  (`exited`, `stopped`, `lost`, `failed`). Stop and deleting the bot stop its services; after a
  restart `keep` ones start again and the rest are `lost`. A running service does not make the
  bot read as working.

## API

- `GET /v1/agents/{id}/wakes`: `{wakes: [{id, purpose, due_at, condition, reason, words,
attempt, job, error, parked}]}`; `purpose` is `sleep`, `wait`, `retry`, `outage` or `park`,
  `parked` the park's reason (`cap`, `check`). `POST /v1/agents/{id}/wakes/{wake}/wake` wakes it now (`202`, `409`
  when not open); `DELETE /v1/agents/{id}/wakes/{wake}` cancels it (`204`, `409`).
- `GET /v1/agents/{id}/services`: `{services: [{id, name, command, cwd, keep, state, exit_code,
restarts}]}`; `GET /v1/agents/{id}/services/{name}/logs?after=&lines=`: `{lines: [{n, text}],
next}`; `DELETE /v1/agents/{id}/services/{name}` stops it (`204`, `409`).
- Every agent shows `wake` (the soonest open wake, as above, or `null`) and `services` (how many
  run).
- `POST /v1/agents` and `PATCH /v1/agents/{id}` accept `access` only as `auto_review`, which
  changes nothing; anything else is `400` (`access must be auto_review: …`).
- Every agent shows `access` (always `auto_review`), `task_state` (`{"status","note"?}` or `null`) and `continuing`
  (`true` while a step Spade started runs or one waits to start).
- `approval_requested` events carry `reviewer_reason`: why the auto-review sent the call to the
  person.
- `GET /v1/agents/{id}/activity`: kinds `access` (name is the level, `auto_review`) and `task` (`continued`,
  `paused`); `review` entries' outcome is `allowed`, `escalated` or `refused`.
- `GET /v1/agents/{id}/task` answers `{"task": {goal, items, verdict, checkpoint, progress}}` or
  `{"task": null}`. `PUT /v1/agents/{id}/task/goal` with `{title, criteria, text?, verifier?}`
  sets the goal or changes the open one (`400` when invalid); `DELETE` ends it (`409` with none
  open). Every agent shows `task_progress {state, items_total, items_closed, items_verified}`;
  `state` is `none`, `working`, `checking`, `not_yet`, `unchecked` or `done`. Show "done" only
  from it, never from `task_state`.
- Activity kind `task` adds `goal drafted`, `goal set`, `goal ended`, `checkpoint`, and the
  verdicts `done`, `not_yet`, `unchecked`.
