# Autonomy: access levels, the auto-review, tasks that keep going

Date: 2026-11-13. As built for [ADR 0144](../../docs/adr/0144-spade-autonomous-bots.md). Extends
[harness.md](harness.md), [workspace.md](workspace.md), [oversight.md](oversight.md) and
[agents.md](agents.md). The pure rules are `spade_core::autonomy` and `spade_core::task`; the
engine side is `engine/autonomy.rs`, `engine/calls.rs` and `engine/continuation.rs`.

## Access levels

| Level         | A call the rule gate would ask about                            |
| ------------- | --------------------------------------------------------------- |
| `ask`         | asks the person (unchanged; the ADR 0135 review still applies)  |
| `auto_review` | goes to the reviewer, unless it is one that always asks (below) |
| `full_access` | runs                                                            |

Calls the rule gate runs (reads, notes in a clean turn, writes allowed always) run on every level.
On `auto_review` the ADR 0135 review still checks those when it is switched on.

- Stored as `{"type":"access_changed","level"}` in the bot's conversation; the latest holds. No
  event means the new-bot level (`auto_review`). The first start of this build stores `ask` for
  every conversation it finds (setting `access_levels_pinned`).
- Read for each call as it is gated (kept in memory once folded, updated when the person changes
  it): a change made while a step's calls are decided applies from the next call.
- `POST /v1/agents` with `access` stores the bot and its `access_changed` in one write, template
  bots included.

### Always the person

On `auto_review` these never reach the reviewer; `call_reviewed` is stored with `model: ""` and
the bubble's `reviewer_reason` names the rule:

| Kind            | How it is recognised                                                                                                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| payment         | `pay`, `purchase`, `buy`, `checkout`, `charge`, `order`, `transfer`…                                                                                                                         |
| credentials     | `password`, `token`, `key`, `permission`, `role`, `invite`, `access`…                                                                                                                        |
| message as you  | `send`, `reply`, `forward`, `email`, `message`, `dm`, `chat`…                                                                                                                                |
| publish         | `post`, `publish`, `share`, `comment`, `deploy`, `merge`, `upload`…                                                                                                                          |
| delete outside  | `delete`, `remove`, `trash`…, or `destructiveHint` / destructive risk                                                                                                                        |
| unknown         | a tool of Spade's not in its table, or an app tool with no annotations                                                                                                                       |
| mislabelled     | an app tool marked read-only whose name, or its description's first word, acts (`send`, `post`, `delete`, `create`, `transfer`…); a read-only one that names credentials asks as credentials |
| tainted routine | `routine_save` / `routine_delete` while untrusted content is in view, on every level, `full_access` included                                                                                 |
| too long        | arguments over 32,000 characters of JSON: the reviewer must read the whole call                                                                                                              |
| shell           | what the shell classifier below finds                                                                                                                                                        |

Words come from the tool's name (split on `_`, `-`, `.` and camelCase), then the first three
words of an app tool's description. An app's annotations are hints from a server Spade doesn't
control: the name and description checks run before a read-only claim counts. Spade's tools that
stay inside the bot (`workspace_*`, `memory_*`, `todo`, `task_status`, `skill_*`, `routine_*`,
`image_generate`, `share_file`) and those that reach another bot (`bot_message`, `group_ask`) go
to the reviewer. ace's tools and app tools that match nothing go to the reviewer, except while
untrusted content is in view, when they ask.

### The shell classifier

**What it is, and what it isn't.** The classifier is a best-effort layer in front of the reviewer.
It catches common ways a command reaches outside the workspace and sends them to the person
before any model judges them. It is not a containment guarantee: a shell can do more than any
reading of its words can follow, and a command it lets through can still reach the network or
write outside the workspace. Containment will come from an OS sandbox in a later change: no
network, and writes only in the workspace and temp folders, unless the reviewer or the person
approves an unsandboxed run. Until then, `auto_review` relies on the reviewer for what the
classifier misses.

When it can't follow what a command will run, it doesn't try harder: it sends the command to the
person as unclear.

`spade_core::autonomy::shell` reads a `shell` command without a model and sends these to the
person whatever the reviewer would say (the reason names the kind):

| Kind          | Commands                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| network       | `curl` with `-d`/`--data*`/`-F`/`-T`/`--upload-file`/`--json`/`-X POST\|PUT\|PATCH\|DELETE`, attached (`-XPOST`, `-Ffile=@x`, `--data=x`) or in a cluster (`-sSd x`); `wget --post-*` (any unambiguous start, `--post-d`)/`--method`; inline code naming the network (`urllib`, `requests`, `fetch`, `http`, `socket`…); `http`/`xh` with a method or fields; `nc`, `socat`, `telnet`, `ssh`, `ftp`, `sftp`; `scp`/`rsync` to a remote |
| mail          | `mail`, `sendmail`, `mutt`, `msmtp`, `swaks`, `git send-email`                                                                                                                                                                                                                                                                                                                                                                         |
| publish       | `git push`; `gh pr\|issue\|release… create\|merge\|edit…`, `gh api` writes (`-f`/`-F` attached or not, `--field=`, `--input`, `-XPOST`); `npm\|cargo\|twine\|gem… publish\|upload`; `docker push`; `vercel`/`netlify`… deploys                                                                                                                                                                                                         |
| server change | `kubectl apply\|delete…`, `helm install…`, `terraform apply\|destroy`, cloud CLIs' writes                                                                                                                                                                                                                                                                                                                                              |
| outside       | `rm`, `mv`, `cp`, `tee`, `dd`, redirects, `find -delete`/`-exec` whose real path, from the terminal's current folder with symlinked folders followed, is outside the workspace or can't be resolved; `~` or a variable; `ln -s` pointing outside                                                                                                                                                                                       |
| other apps    | `osascript`, `open`, `xdotool`, `shortcuts`                                                                                                                                                                                                                                                                                                                                                                                            |
| admin         | `sudo`, `su`, `launchctl`, `systemctl`, `crontab`, `diskutil`…                                                                                                                                                                                                                                                                                                                                                                         |
| payment       | `stripe`, `paypal`                                                                                                                                                                                                                                                                                                                                                                                                                     |
| unclear       | what it can't read: here-documents, `eval`, backticks, `$((…))`, a program from a variable, a shell reading from a pipe (`base64 -d \| sh`), unbalanced quotes, `curl -K`/`--config`, `wget -e`, `parallel` reading commands from its input; inline code that starts programs or builds code (`subprocess`, `child_process`, `os.system`, `eval(`, `base64`, awk's `system()` and pipes)                                               |
| unseen script | a file the command runs that Spade can't show: outside the workspace, through `~` or a variable, missing, unreadable, or over 24,000 bytes                                                                                                                                                                                                                                                                                             |

It tries to read every simple command: across `|`, `;`, `&&`, `||`, `$(…)`, `sh -c`/`bash -c` strings,
variable assignments and wrappers. What a wrapper runs (`find -exec`/`-execdir`/`-ok`, `xargs`,
`parallel`, `timeout`, `nice`, `nohup`, `time`, `watch`, `command`, `builtin`, `exec`, `env`
and `env -S`, `flock`, `sudo`, `doas`, `su -c`…) is unwrapped through the same reading, and each
command gets both the credential and the effect checks. A command with no `command` argument is
unclear. Anything it passes still goes to the reviewer.

Inline code (`python -c`, `node -e`, `perl -e`, `ruby -e`, `php -r`, an awk program) is in the
call, so the reviewer reads it and its `outward_or_irreversible` decides, unless the markers above
send it to the person first.

**Scripts.** A command that runs a file is judged by the file: `./x.sh`, `bin/x`, `sh x.sh`,
`source x`, `python x.py`, `node x.js` (and `-r` preloads), `ruby`, `perl`, `go run`, `tsx`,
`deno run`, `make` and `just` (the makefile or justfile, `-f`/`-C` honoured), and package scripts
(`npm|pnpm run|test|start…`, `yarn <script>`, `bun run`: the `pre`, main and `post` entries
of `package.json`). On `auto_review` the reviewer is shown each file whole in `<runs>`;
shell scripts, recipe lines and package scripts are also checked like commands, and a file that
names a credential place is refused. The approval is bound to the SHA-256 of what was shown
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
{ "verdict": "approve" | "refuse" | "escalate", "reason": "one sentence",
  "outward_or_irreversible": false }
```

- `outward_or_irreversible` is required: an answer without it doesn't parse and escalates.
- `approve` runs; with `outward_or_irreversible` it escalates instead for `shell`, and for any
  call while untrusted content is in view.
- It reads the call's arguments whole, never cut; a call too long for that goes to the person.
- It is told of every untrusted source still in the model's view: this turn's, an earlier
  turn's since the last compaction, or a summary drawn from one.
- Its cost counts toward the caps even when the provider sends no usage (a timeout, Stop, an
  error that may have billed): Spade settles an estimate from the prompt.
- `refuse`: the call's result is `Not run: <reason> Don't try the same call again; …`, not an
  error.
- Failure, a 60 s timeout, unparseable output or a cap: escalates with the reason.
- Status line while it reads: `Checking a step`.

### Credentials

On every level, `ask` included, and for every call, reads included, a call is refused when any
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
`create`…) goes to the person instead:
`Not run: Spade never lets a bot read sign-in tokens, keys or provider credentials.` This is a
list of known places and tools, so it misses what it doesn't know; it is a guard rail in front of
the reviewer and the person, not a sandbox.

### Routines

A routine saved or changed by a bot while untrusted content is in view asks the person first
(above) and is marked `untrusted` for good (the `routines.untrusted` column). Routines that
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
| task not `working`; already paused since the latest message | nothing                                    |
| 25 steps since the person's latest message                  | pause (`budget`)                           |
| the last 3 steps had no effect                              | pause (`no_progress`)                      |
| the last step had an effect                                 | continue now                               |
| the last _n_ steps had none                                 | continue after 30 s × 2ⁿ⁻¹, at most 15 min |

An effect is a started call of risk write, destructive or memory, or a `todo` / `task_status`
call with arguments different from the one before it. The engine also starts nothing while the
bot is at a cap, Spade is closing, or the person has the bot's computer.

A continued step is stored as `task_continued {step, nudge}` followed by `reply_started`, in one
write. The model reads `nudge` (`<continue step="n">…</continue>`) as a note from Spade; CLI
brains get it as their next turn. The step's taint reaches back to the latest message. A pause is
`task_paused {reason, steps}`, stored once.

Only the person's message resets the budget and the pause; a bot's message or a routine's firing
carries on the task it belongs to. `task_state` on the roster and the continuation read the same
history: the latest valid `task_status`.

The turn's worker decides and registers the next step before it lets go of the conversation.
Stop reads what runs, calls off a waiting step and stores `stop_requested` under the one lock work
starts under, then signals the workers, so a Stop pressed at any point after a reply ends calls
the step off. A step waiting out its backoff waits on the engine's clock; Stop
on an idle bot with a step waiting stores `stop_requested` with no reply and calls the step off.

## API

- `POST /v1/agents` and `PATCH /v1/agents/{id}` take `access`: `ask`, `auto_review` or
  `full_access` (anything else is `400`).
- Every agent shows `access`, `task_state` (`{"status","note"?}` or `null`) and `continuing`
  (`true` while a step Spade started runs or one waits to start).
- `approval_requested` events carry `reviewer_reason` when the auto-review sent the call to the
  person.
- `GET /v1/agents/{id}/activity`: kinds `access` (name is the level) and `task` (`continued`,
  `paused`); `review` entries' outcome is `allowed`, `escalated` or `refused`.
