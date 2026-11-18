# Autonomy: the auto-review, tasks that keep going

Date: 2026-11-13, amended 2026-11-15. As built for
[ADR 0144](../../docs/adr/0144-spade-autonomous-bots.md) and
[ADR 0163](../../docs/adr/0163-spade-auto-review-only.md) (one level). Extends
[harness.md](harness.md), [workspace.md](workspace.md), [oversight.md](oversight.md) and
[agents.md](agents.md). The pure rules are `spade_core::autonomy` and `spade_core::task`; the
engine side is `engine/autonomy.rs`, `engine/calls.rs` and `engine/continuation.rs`.

## One level: the auto-review

Every bot is on the auto-review (ADR 0163). Where a call goes is decided by what it does, its
effect, and where it runs ([ADR 0171](../../docs/adr/0171-spade-decides-on-effects.md),
`spade_core::effect::route`). The reviewer sees only what the table below sends it, and the ADR
0135 review still checks calls the gate runs when it is switched on (never a sandboxed one).

- Old `{"type":"access_changed","level"}` events read as `auto_review`, whatever level they name.
  Once, on its first start, this build appends an `access_changed` to `auto_review` to each
  conversation whose latest stored level is `ask` or `full_access` (`Store::latest_field`), then
  stores the setting `access_levels_retired` and removes `access_levels_pinned`.
- Nothing else stores a level: creating or changing a bot never writes one.

### Effects

Every tool declares its effect once (ADR 0171 and its amendment 1):

| Effect           | Meaning                                                            |
| ---------------- | ------------------------------------------------------------------ |
| `read`           | only reads                                                         |
| `write_local`    | changes only the bot's own things (folder, notes, routines)        |
| `network`        | changes something outside the bot (an app, another bot, ace)       |
| `publish`        | a release, a package, a deploy, a merge                            |
| `send_as_person` | a message, mail, comment or push in the person's name              |
| `pay`            | spends money                                                       |
| `drive`          | acts in a page or app as the person would (a click, typing, a key) |
| `change_access`  | changes sign-ins, keys or who has access                           |
| `unknown`        | a declared word this build doesn't know                            |
| `credential`     | hands back a secret                                                |

- **Spade's own tools:** the table `BUILTIN` in `spade_core::effect`. A tool missing from it is
  `read` when its risk is read, `write_local` when it is a note, and otherwise declares nothing.
  `bot_message`, `bot_create` and `worker_message` reach another bot and are `network`; the typed
  tools below are `send_as_person`.
- **ace's tools:** ace's risk: `read`, else `network`, and a `browser_*`, `screen_*` or `sim_*`
  call ace doesn't mark read-only is `drive`. ace's names never make a send.
- **Connector and plugin tools:** a trusted declaration is the least a tool does: a connector
  catalogue entry's `effects` (by the server's tool name) and `every_tool` (every tool of the
  app, read-only or not), and a plugin server's execution entry's `effects`. MCP hints can only
  raise it: a tool not marked `readOnlyHint` is at least `network`. A tool with no trusted
  declaration declares nothing, whatever its hints say. The shipped catalogue marks every
  PayPal, Square and Stripe tool as `pay`, and GitHub's `add_issue_comment` as `send_as_person`
  and `merge_pull_request` as `publish`.
- A declared word Spade doesn't know is `unknown`, never dropped. Names and descriptions are
  never read for words.

### Where a call goes

In order, first match wins:

| Facts                                                                             | Goes to                                                                               |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| its arguments name a credential place (not for a sandboxed call), or `credential` | refused: `Not run: Spade never lets a bot read…`                                      |
| `pay`, `change_access`, `unknown`                                                 | the person, unless allowed always                                                     |
| `send_as_person`                                                                  | the person, unless allowed always or a typed grant covers it                          |
| `drive` in a sensitive place, or one Spade can't name                             | the person (`ask: drive`), even when allowed always                                   |
| `drive` elsewhere                                                                 | runs on Always allow; otherwise the reviewer, told where it acts (below)              |
| a command outside the sandbox, or on a machine with none                          | the classifier and ADR 0163's route (below)                                           |
| it declares nothing, in the sandbox                                               | runs                                                                                  |
| it declares nothing                                                               | the person once (`ask: undeclared`); their answer is kept for the bot and that tool   |
| in a sandbox that holds files and network                                         | runs                                                                                  |
| in the sandbox, but its checkpoint couldn't be taken                              | the reviewer, told so                                                                 |
| a command asking to run outside (`outside_sandbox: true`)                         | the person (`ask: outside_sandbox`)                                                   |
| a routine set up under untrusted content                                          | the reviewer, with that concern                                                       |
| `read`                                                                            | runs                                                                                  |
| `write_local`                                                                     | runs; a file write with no checkpoint, or a note under untrusted content, is reviewed |
| `network`                                                                         | runs on a `tool` grant or Always allow; otherwise the reviewer                        |
| `publish`                                                                         | the reviewer, unless allowed always                                                   |

A `tool` grant covers only a tool that declares `read`, `write_local`, `network` or `publish`.
An undeclared tool's answer is kept under the bot and the tool's identity: its server (a
connection and its address, or a plugin, its accepted version and server), its own name and a
hash of its schema, never the name it is offered under; a helper reads its bot's. A name two
sourced tools would be offered under (two servers, or names cut to a provider's 64 characters) is
offered for neither. A remembered allow still asks the person while untrusted content is in view.
A covered push or comment under untrusted content is reviewed with the grant named. Requests the
rules raise store `call_reviewed` as `escalate` with `model: ""`; the bubble's `reviewer_reason`
is the rule's line, such as "It could spend money, so you decide.", "It acts in Mail, mail or
messages, where it can send in your name, so you decide.", "It pushes to github.com/acme/app, branch main with your sign-in, so you
decide.", "It sends something in your name to github.com/acme/app#7, so you decide.", "It
declares something Spade doesn't know yet, so you decide.", "It doesn't say what it does, so you
decide once for this bot." or "It asks to run outside the sandbox, so you decide."

### Driving a page or app

[ADR 0171](../../docs/adr/0171-spade-decides-on-effects.md) amendment 3. Right before the gate
decides, Spade asks ace where a `drive` step acts (`spade_core::effect::drive::lookup`): the tab
it runs in (its `tabId`, else ace's current tab) from `browser_tabs list`, or every app ace could
open for its `app` from `screen_apps`. A step that opens an address acts there. A tab that is
loading, missing or private, a name that matches several apps, and input on a simulator or device
have no place, and go to the person. Right before the step runs, Spade asks again; if the place
changed, the step isn't run and the bot looks again. It goes to the person in mail, messages or chat, a bank,
wallet, payment, checkout or cart, a password manager, the system's settings, a sign-in, account,
security, settings, keys or members page, a social site, a web browser driven through the screen,
or a place Spade can't name (`drive::sensitive`). Elsewhere the reviewer is told it acts there
as the person and to escalate a send, a payment, a purchase, an access change or a password;
under untrusted content, to check the step serves the person's request.

A request for a step outside those places offers "Allow \<app\> for this bot" (the request's
`app`). It answers always and adds the grant `drive_app {app}` (the app's id) or
`drive_site {host}` for the place the request kept (`acts_in`): the steps it covers are reviewed,
told the person allowed the app, without asking. A drive grant is refused for a sensitive place,
a `tool` grant never covers a driving tool, and the request never stores an Always allow.

#### Where each operation acts

One table decides (`spade_core::effect::drive::table`): a row per tool and operation, what that
operation acts on in ace's own implementation, the only fields the gate reads to find it, and
whether ace must hold it there (`expect`) before the reviewer alone may let it run. A field an
operation ignores never moves the place, and a tool or operation missing from the table has no
place, so the person decides. Read-only tools (`browser_snapshot`, `_wait_for`, `_find`,
`_screenshot`, `_logs`, `screen_apps`, `screen_display`, `screen_windows`, `screen_ui_tree`,
`screen_screenshot`, `sim_list`, `sim_ui`, `sim_screenshot`, `sim_logs`) are `read` and never
reach the table.

| Tool and operation                                   | What it acts on in ace                                                                      | How the gate finds it                                    | Held |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---- |
| `browser_open`                                       | navigates `tabId`, else the caller's own tab, to `url`                                      | `url`; without one, the tab ace lists (`tabId`, current) | no   |
| `browser_tabs list`                                  | lists the tabs                                                                              | the current tab (`tabId` ignored)                        | no   |
| `browser_tabs open`                                  | a new tab at `url`                                                                          | `url`; without one, no place                             | no   |
| `browser_tabs select`                                | makes `tabId` current, then opens `url` there if given                                      | `url` if given, else the tab `tabId` names               | yes  |
| `browser_tabs keep`, `close`                         | the tab `tabId` names (`url` ignored); the last one closes all                              | the tab `tabId` names; without one, no place             | yes  |
| `browser_act` (click … scroll)                       | input to `tabId`, else the caller's current tab                                             | the tab ace lists (`tabId`, else current)                | yes  |
| `browser_act dialog`                                 | the tab that raised `dialogId`, whatever `tabId` says                                       | the tab whose `pending_dialog` is `dialogId`             | yes  |
| `browser_evaluate` with `mode: read-only`            | a side-effect-free script (an isolated world, `throwOnSideEffect`) in `tabId`, else current | the tab ace lists                                        | yes  |
| `browser_evaluate`, unrestricted (ace's default)     | any script in the page                                                                      | no place: the person decides                             | —    |
| `browser_history back`, `forward`, `reload`, `stop`  | moves `tabId`, else current                                                                 | the tab ace lists                                        | yes  |
| `browser_history` with no direction                  | reads the tab's history                                                                     | the tab ace lists                                        | no   |
| `browser_measure`                                    | every repetition's input to `tabId`, else current                                           | the tab ace lists                                        | yes  |
| `browser_settings resize`, `emulate`, `record_start` | the tab's size, device or recording                                                         | the tab ace lists                                        | no   |
| `browser_settings record_stop`, `extensions`         | the session's recording, the browser's extensions (`tabId` ignored)                         | no place: the person decides                             | —    |
| `browser_settings close`                             | the whole browser and every tab                                                             | no place: the person decides                             | —    |
| `browser_request_help`                               | hands the named tab to the person                                                           | the tab `tabId` names                                    | no   |
| `screen_state`, `screen_act`                         | the app ace opens for `app`; a batch goes to its id                                         | every app `screen_apps` lists for `app`                  | yes  |
| `screen_open_app` (older toolkit)                    | opens `bundleId`                                                                            | the app `bundleId`                                       | no   |
| `screen_ui_act`, `screen_input`, `screen_measure`    | a session's app (older toolkit)                                                             | no place: the person decides                             | —    |
| `sim_start`, `sim_stop`                              | the device `simId`                                                                          | the device                                               | no   |
| `sim_act open_app`, `open_url`                       | the app or address the device opens                                                         | `appId`, or `url` as the device's page (never a site's)  | no   |
| `sim_act install`, `record_*`, `posture`             | the device                                                                                  | the device                                               | no   |
| `sim_act ui`, `tap`, … `type`, `key`, `clipboard_*`  | whatever app is in the device's foreground                                                  | no place: the person decides                             | —    |

ace checks a held step in the tab's queue, and the command then runs inside its hold: every CDP
command that sends input or moves the page, from any session the backend holds (the page, its
frames, the person's own Chrome, the desktop's tabs) and whichever helper sends it, and every
input the desktop takes as an operation, checks the place where it leaves for the page: inside
the transport's slot, right before the write, after waiting for one, and against the page's own
answer to where it is (asked of the page right then, so a route a handler just changed counts
before the browser reports it; a frame, or a page that gives no value, falls back to the
browser's report, and one that can't answer fails the step). The end of
a press, key or touch begun under the hold that finds the place changed is never sent (a drag is
cancelled instead), so no mouseup, click, keyup or drop lands on the page the tab moved to; the
step fails with `place_changed`. A test lists every way a command leaves for a page and fails if
one skips the hold. Only the tools ace holds take `expect`; a test fails if a tool takes it and
drops it before it runs.

An answer to a request Spade asked for a reason of its own (`ask`) is never stored as an Always
allow. On the outside card, Always for this bot sets the bot's `commands` to `outside` and runs
that call; the next command is reviewed like any command outside the sandbox. A request to run
outside is bound to the scripts the command would run (`call_reviewed.bound`); if any changed
when the allowed call starts, it isn't run.

### The typed outward tools

Credentials never enter the sandbox, so what needs the person's sign-in goes through a tool that
runs outside it (`tools/outward/`), a fixed program with arguments, never a shell. A repository
is `host/owner/name`; `owner/name` means GitHub, and grants match the host too.

- `git_push {repo, branch, remote?, path?}`: inside the bot's sandbox, a fixed script refuses a
  `.git` that is or holds a link or an alternates file, prints the remote's URL as stored (the
  repository's `insteadOf` never applies) and writes a bundle of the branch into a fresh folder of
  Spade's that only that run may write. On the host, Spade fetches only that bundle (a regular
  file) into a clean repository, adds the URL as remote `dest`, and pushes with hooks off
  (`core.hooksPath=/dev/null`, `--no-verify`), never forced, only when `git remote get-url
--push dest` (after the person's own URL rewriting) is `https` or ssh to the host and repository
  named. Without a sandbox on the machine it doesn't run.
- `pr_comment {repo, number, body}` and `issue_comment {repo, number, body}`: `gh … comment
--repo host/owner/name --body-file -` in Spade's folder, the body on stdin. A `pr_comment` grant
  covers the first (`own_only` grants cover nothing yet).
- `send_message {app: messages | mail, to, body, subject?}`: macOS only; Spade's own AppleScript
  file, with who and what as its arguments.

Every value is checked first (`spade_core::outward`): nothing can start with `-`, a branch must
be one git accepts, a body at most 65,000 characters. A run past 120 s is cut and reported as
maybe sent.

### The shell classifier

**Only for commands outside the sandbox.** A command that runs in a working sandbox is never
classified (ADR 0171). The classifier reads commands that run with no sandbox: a bot set to run
outside it, a call the person allowed outside it, and machines without a sandbox (Linux and
Windows today). It is a best-effort layer in front of the reviewer, not a containment guarantee:
a shell can do more than any reading of its words can follow.

When it can't follow what a command will run, it doesn't try harder: it sends the command to the
person as unclear.

`spade_core::autonomy::shell` reads a `shell` command without a model and names these to the
reviewer as its concern (mail and payment go to the person instead, above):

| Kind          | Commands                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| network       | `curl` with `-d`/`--data*`/`-F`/`-T`/`--upload-file`/`--json`/`-X POST\|PUT\|PATCH\|DELETE`, attached (`-XPOST`, `-Ffile=@x`, `--data=x`) or in a cluster (`-sSd x`); `wget --post-*` (any unambiguous start, `--post-d`)/`--method`; inline code naming the network (`urllib`, `requests`, `fetch`, `http`, `socket`…); `http`/`xh` with a method or fields; `nc`, `socat`, `telnet`, `ssh`, `ftp`, `sftp`; `scp`/`rsync` to a remote; `/dev/tcp/` or `/dev/udp/` anywhere in the command; `npx`, `npm exec`, `pnpm dlx`, `yarn dlx`, `bunx` of a package not in `node_modules/.bin`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| mail          | `mail`, `sendmail`, `mutt`, `msmtp`, `swaks`, `git send-email`; an AppleScript or JavaScript for Automation script (`osascript -e`, a here-document or here-string, a script file, `-l JavaScript`) that names Messages, Mail, Outlook, WhatsApp, Slack, Telegram, Discord, Signal, Teams or a similar app and sends, replies, forwards, posts or types into it; `shortcuts run` of a shortcut whose name says it sends (`Send Message`, `Text Mom`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| publish       | `git push`; `gh pr\|issue\|release… create\|merge\|edit…` (`gh pr\|issue comment` is a send as you), `gh api` writes (`-f`/`-F` attached or not, `--field=`, `--input`, `-XPOST`); `npm\|cargo\|twine\|gem… publish\|upload`; `docker push`; `vercel`/`netlify`… deploys                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| server change | `kubectl apply\|delete…`, `helm install…`, `terraform apply\|destroy`, cloud CLIs' writes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| outside       | `rm`, `mv`, `cp`, `tee`, `dd`, redirects, `find -delete`/`-exec` whose real path, from the terminal's current folder with symlinked folders followed, is outside the workspace or can't be resolved; `~` or a variable; `ln -s` pointing outside                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| other apps    | `osascript` (a script file it can't read stays here), `open`, `xdotool`, `shortcuts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| admin         | `sudo`, `su`, `launchctl`, `systemctl`, `crontab`, `diskutil`…                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| payment       | `stripe`, `paypal`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| unclear       | what it can't read: here-documents and here-strings (except an `osascript` script's, which is read, if its body runs no `$(…)` or backticks), `eval`, backticks, `$((…))`, a program from a variable, a shell reading from a pipe (`base64 -d \| sh`), unbalanced quotes, `curl -K`/`--config`, `wget -e`, `parallel` reading commands from its input; `xargs` or `find -exec` handing a shell or interpreter text from its input (`xargs sh -c '{}'`, `sh -c '{}'`); a file the same command writes, downloads or may rewrite (`cp`, `curl -o`, `wget`, `sed -i`, `tar x`, `unzip`, `git pull`/`checkout`…) and also runs; a `cd` to somewhere it can't resolve (`cd`, `cd -`, `cd $X`, `popd`); a git alias (a first word git doesn't have) or a command given as git configuration (`-c core.hooksPath=`, `-c alias.`); hooks moved elsewhere (`core.hooksPath` in the repository's config) or a `.git` that is a file; `make -e`/`--eval`, and in the selected goals `$(shell)`, `$(eval)`, `$(call)` or `!=`; another shell or language in a justfile recipe; inline code that starts programs or builds code (`subprocess`, `child_process`, `os.system`, `eval(`, `base64`, awk's `system()` and pipes) |
| unseen script | a file the command runs that Spade can't show: outside the workspace, through `~` or a variable, missing, unreadable (a binary), or over 24,000 bytes; a makefile `include` that is missing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

It tries to read every simple command: across `|`, `;`, `&&`, `||`, `$(…)`, `sh -c`/`bash -c` strings,
variable assignments and wrappers. What a wrapper runs (`find -exec`/`-execdir`/`-ok`, `xargs`,
`parallel`, `timeout`, `nice`, `nohup`, `time`, `watch`, `command`, `builtin`, `exec`, `env`
and `env -S`, `flock`, `sudo`, `doas`, `su -c`…) is unwrapped through the same reading, and each
command gets both the credential and the effect checks. A command after a shell keyword (`{`,
`if`, `then`, `else`, `elif`, `while`, `until`, `do`, `!`, `function name`) is read, so a function
defined in the command has its body read where it is written. An alias defined in the command is
read through to its text wherever it is used (a shell may expand it); one whose text can't be read
is unclear. A command with no `command` argument is
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

### Spade's classifier

[ADR 0172](../../docs/adr/0172-spade-classifies-calls-with-its-own-model.md). A small model built
into Spade (`spade-classify`, int8, 1.3 MB, microseconds a call, no network) sits between the
table above and the reviewer. It sees only calls the table sent to the reviewer, so it never
changes what the rules decided, and only two kinds of them: a command that runs with no sandbox,
and a connector's or plugin's tool. For each it does one of three things:

| It reads                                                                                                    | Goes to                                                                      |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| a person-only effect (`pay`, `send_as_person`, `drive`, `change_access`, `credential`), above its threshold | the person, with that effect's line ("It could spend money, so you decide.") |
| low-risk (`read`, or `write_local` in the bot's folder), above its threshold, for a command it may settle   | runs                                                                         |
| anything else                                                                                               | the reviewer, as without it                                                  |

It may settle only a command the shell classifier found nothing in, that runs no file the
reviewer would be shown, with nothing untrusted in view, no standing work and no concern named.
It never settles a command that points outside the bot's folders (the home folder, an absolute
path, `..`, a variable, another machine, a URL that isn't a web page), that hides what it runs
(decoded text run as code, `eval`, a program from a variable, an alias or function defined in the
command, escapes, look-alike or invisible letters, text that can't be read), or that has a
program, subcommand or flag never seen in a low-risk training command.

A call it settles or raises stores `call_reviewed` with `model` `spade-classify/<hash>` and no
cost. Each decision is logged in `<data>/classifier/decisions.jsonl` (rolling at 1 MiB, one older
file kept): when, the conversation, the call's id and tool name, the class, its confidence, the
low-risk and person-only probabilities and the decision, never the call's arguments. The machine's
setting `classifier` (`PUT /v1/oversight`) turns it off; everything then goes to the reviewer.
Its measures, data and thresholds are in `spade/crates/spade-classify/model/REPORT.md`; it is
retrained with `spade/tools/classify-train`.

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
- Its cost is recorded even when the provider sends no usage (a timeout, Stop, an
  error that may have billed): Spade settles an estimate from the prompt.
- It may write up to 4,000 tokens (`REVIEW_TOKENS`, the ADR 0135 review too): a reasoning
  model spends that budget on its thinking before the JSON, and a tight one cuts the answer off.
- An answer that comes back empty, cut short or unparseable (an `escalate` verdict included) is
  asked for once more, within the same 60 s; each try's cost is recorded.
- Failure, a 60 s timeout, or a second answer Spade can't read: the person is asked, with one
  plain sentence ("The reviewer couldn't decide on this, so you decide.", "The reviewer
  couldn't be reached, so you decide.", "The review took too long, so you decide."). The raw
  error, with model and type names, goes to the logs only. An unreviewed call never runs.
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

For every call that doesn't run in the sandbox, reads included and whatever the person allowed
always, a call is refused when any string in its arguments names a place where sign-ins live
(`~/.codex`, `~/.claude`, `~/.claude.json`, `~/.config/gh/hosts.yml`, `~/.aws`, `~/.ssh`,
`.netrc`, `~/.docker/config.json`, `.npmrc`, `.pypirc`, `.git-credentials`, `~/.gnupg`, the
keychain folders, `~/.kube/config`, ace's account homes and token, Spade's database), whatever
program reads it, or reads as a command that reads secrets (`security find-*-password`/
`dump-keychain`/`export`, `secret-tool lookup`, `gpg --export-secret*`, `pass`, `op`, `bw`,
`keyring get`, `gh auth`, `git credential`…), across pipes, wrappers and `sh -c` strings
(`spade_core::autonomy::secrets`), or the tool declares `credential`:
`Not run: Spade never lets a bot read sign-in tokens, keys or provider credentials.` A sandboxed
call skips this list: the sandbox's deny-list closes those places to it. A tool that declares
`change_access` goes to the person.

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

**Spend never stops a task** ([ADR 0166](../../docs/adr/0166-spade-has-no-spending-limits.md)): there are no spending caps or budgets. Builds before it
parked a task at a cap (`wake_set {purpose: {kind: park, reason: cap}}`) and a worker at its
budget (`wait_for {condition: {kind: budget}}`). Such a wake found open when Spade opens is
cancelled (`wake_cancelled {by: spade}`) and the task carries on. A reply such a build ended at a
cap (`reply_failed` of kind `cap`) counts as finished, so its task carries on too. A
`task_parked` stored by an earlier build is still read and ignored.

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
  results, quoted. `done` needs every criterion met and no item rejected. A check whose model
  fails in a way that may pass parks it on `wake_set {purpose: {kind: park, reason: check, attempt}}` with the same
  backoff as an outage (1, 2, 4 … minutes, at most an hour). The task reads as
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
  `parked` the park's reason (`check`). `POST /v1/agents/{id}/wakes/{wake}/wake` wakes it now (`202`, `409`
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
