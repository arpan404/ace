# The ace CLI

<!-- Generated from apps/daemon/src/cli/commands by `bun apps/daemon/scripts/cli-doc.ts`. Don't edit by hand. -->

Every command is `ace <noun> <verb> [ARGUMENTS] [FLAGS]` ([ADR 0178](../adr/0178-one-cli-grammar-interactive-home-and-market.md)).
`ace help COMMAND` prints the same page in a terminal, and `ace help --json` prints all of it as JSON.

## Global flags

| Flag | Means |
| --- | --- |
| `-h, --help` | This command's help |
| `--json` | Print one JSON value; implies --no-input |
| `--jq EXPR` | --json filtered through the installed jq |
| `-q, --quiet` | Print only identifiers, one per line, or nothing |
| `--no-input` | Never prompt; a missing argument is a usage error |
| `-y, --yes` | Answer yes to a confirmation; never answers a person-only action |
| `--remote NAME` | Run against a remote profile (ace remote list) |
| `--timeout DURATION` | Stop observing after this long: 30s, 10m, 0 |
| `--color WHEN` | auto, always or never; auto follows the terminal and NO_COLOR |
| `-v, --version` | The CLI's version |

## Exit codes

| Code | Name | Means |
| --- | --- | --- |
| 0 | `ok` | Done |
| 1 | `failed` | The work or check failed |
| 2 | `needs-human` | A person must act: a request is open, or sign-in |
| 3 | `timeout` | Stopped watching; the work may still run |
| 4 | `refused` | ace understood and said no: not allowed, not found, off |
| 5 | `uncertain` | Not known whether it happened; retry with the same key |
| 6 | `address-in-use` | ace start: the port is taken |
| 7 | `lock-held` | ace start: another daemon holds this ace home |
| 64 | `usage` | The command line was wrong |
| 65 | `newer-data` | A newer ace wrote this home |
| 66 | `incompatible-data` | A store is in a format this build can't read |

## Start

### `ace help [COMMAND…] [flags]`

Help for a command or a topic.

- `COMMAND`: A command or topic

- `--schema`: The command's --json output as JSON Schema

    ace help thread
    # Everything you can do to a thread

    ace help --json
    # Every command, flag and exit code as JSON

    ace help agents
    # How agents should call ace

### `ace version`

The CLI's version.

### `ace completion SHELL`

Tab completion for bash, zsh, fish or PowerShell.

Completes commands, flags and choices, and asks the running daemon for thread ids, project names, open request ids and Spade bot names; zsh, fish and PowerShell show each with a thread's title or a project's folder beside it. With ace down, or no answer within 300 ms, it completes what the command table knows. Completion never starts ace, never prompts and never writes.

- `SHELL`: bash, zsh, fish, powershell, or install

    ace completion install
    # Install it for your shell

    eval "$(ace completion bash)"
    # Try it in this bash

### `ace status`

This machine: the daemon, your account, what needs you, what runs.

## Work

### `ace thread list [flags]`

Your threads, in the app's order.

Pinned first, then what needs you, what runs, what finished unseen and the rest. Settled and snoozed threads are left out unless asked for.

- `--project PROJECT`: A project id, name or path
- `--needs-you`: Only threads waiting on you
- `--running`: Only threads at work
- `--settled`: Only settled threads
- `--limit N`: At most N results
- `--after CURSOR`: The page after this cursor (from the last page's next)

    ace thread list
    # Every thread

    ace thread list --needs-you --quiet
    # Ids of threads waiting on you

    ace thread list --project ace --json
    # One project's, as JSON

### `ace thread show [THREAD] [flags]`

One thread's transcript, requests and state.

Without THREAD on a terminal, offers a list of threads to pick from.

- `THREAD`: A thread id, or at least 6 characters of one

- `--items N`: Show the last N items (default 20, at most 200)
- `--before CURSOR`: The items before this cursor (from Earlier:)

    ace thread show t_9f2c41
    # Read a thread

    ace thread show t_9f2c41 --items 50
    # More of it

### `ace thread start PROMPT|- [flags]`

Start an agent on a prompt.

Registers the project when given a path, then starts a thread on your default provider from Settings. Without a prompt on a terminal it asks for one; elsewhere pass the prompt or - to read it from stdin.

- `PROMPT`: What to do; - reads stdin

- `--project PROJECT`: A project id, name or path
- `--provider PROVIDER`: codex, claude, cursor, opencode, antigravity or pi
- `--model MODEL`: The model to use
- `--worktree`: Work in a new git worktree
- `--parent THREAD`: Start it as a child of this thread
- `--role ROLE`: The child's role, shown in its parent's tree
- `-f, --follow`: Keep printing as it changes; JSON Lines with --json
- `--idempotency-key KEY`: Run this mutation at most once; retry with the same key

Shortcut: `ace run`.

    ace run "Fix the flaky upload test"
    # Start in this folder

    git diff | ace thread start - --provider claude --follow
    # Prompt from stdin, then follow the whole tree

### `ace thread attach [THREAD] [flags]`

Talk with an agent in this terminal.

- `THREAD`: A thread to continue; omit to start one

- `--project PROJECT`: A project id, name or path
- `--provider PROVIDER`: codex, claude, cursor, opencode, antigravity or pi
- `--model MODEL`: The model to use
- `--idempotency-key KEY`: Run this mutation at most once; retry with the same key

Shortcut: `ace chat`.

    ace chat
    # A new conversation in this folder

    ace chat t_9f2c41
    # Continue a thread

### `ace thread send THREAD TEXT|- [flags]`

Queue a message for when the agent's turn ends.

- `THREAD`: A thread id, or at least 6 characters of one
- `TEXT`: The message; - reads stdin

- `--idempotency-key KEY`: Run this mutation at most once; retry with the same key

### `ace thread steer THREAD TEXT|- [flags]`

Send a message into the agent's current turn.

- `THREAD`: A thread id, or at least 6 characters of one
- `TEXT`: The message; - reads stdin

- `--idempotency-key KEY`: Run this mutation at most once; retry with the same key

### `ace thread stop [THREAD] [flags]`

Stop a thread and every agent under it.

- `THREAD`: The thread to stop

- `--all`: Stop all running work
- `--provider PROVIDER`: With --all, only this provider's work
- `--project PROJECT`: With --all, only this project's work
- `--idempotency-key KEY`: Run this mutation at most once; retry with the same key

    ace thread stop t_9f2c41
    # Stop one thread's tree

    ace thread stop --all --provider codex
    # Stop all Codex work

### `ace thread wait THREAD… [flags]`

Wait until threads finish, or until one needs you.

Never reports done while any agent in a tree still works or waits on a person. Exits 2 as soon as a person is needed.

- `THREAD`: Up to 16 thread ids

- `--any`: Return when the first one finishes
- `--all`: Return when every one finishes (the default)
- `--tree`: Wait for each thread's whole agent tree
- `-f, --follow`: Keep printing as it changes; JSON Lines with --json

### `ace thread status THREAD`

A thread's state; the exit code follows it.

- `THREAD`: A thread id, or at least 6 characters of one

### `ace thread tree THREAD`

A thread's agent tree: each agent and what it does.

- `THREAD`: A thread id, or at least 6 characters of one

### `ace thread resume THREAD [flags]`

Carry on a thread that stopped at a restart or a pause.

- `THREAD`: A thread id, or at least 6 characters of one

- `--idempotency-key KEY`: Run this mutation at most once; retry with the same key

### `ace thread rename THREAD NAME [flags]`

Give a thread a new title.

- `THREAD`: A thread id, or at least 6 characters of one
- `NAME`: Its new title

- `--idempotency-key KEY`: Run this mutation at most once; retry with the same key

### `ace thread settle THREAD [flags]`

Settle a thread: it leaves the list until it changes.

- `THREAD`: A thread id, or at least 6 characters of one

- `--idempotency-key KEY`: Run this mutation at most once; retry with the same key

### `ace thread unsettle THREAD [flags]`

Bring a settled thread back to the list.

- `THREAD`: A thread id, or at least 6 characters of one

- `--idempotency-key KEY`: Run this mutation at most once; retry with the same key

### `ace thread snooze THREAD [flags]`

Hide a thread until a time or an event.

- `THREAD`: A thread id, or at least 6 characters of one

- `--until WHEN`: 1h, 30m, 2d, tomorrow, monday, needs-you or pr-changes
- `--idempotency-key KEY`: Run this mutation at most once; retry with the same key

    ace thread snooze t_9f2c41 --until tomorrow
    # Until 9:00 tomorrow

    ace thread snooze t_9f2c41 --until needs-you
    # Until it asks

### `ace thread fork THREAD [TEXT|-] [flags]`

Start a new thread from a thread's last turn.

- `THREAD`: A thread id, or at least 6 characters of one
- `TEXT`: The fork's first message; - reads stdin

- `--title TITLE`: The new thread's title
- `--idempotency-key KEY`: Run this mutation at most once; retry with the same key

### `ace thread model THREAD MODEL [flags]`

Switch a thread's model from its next turn.

- `THREAD`: A thread id, or at least 6 characters of one
- `MODEL`: The model id

- `--idempotency-key KEY`: Run this mutation at most once; retry with the same key

### `ace request list [flags]`

Every open approval, question and plan, across threads.

- `--thread THREAD`: Only this thread's and its agents'

    ace request list
    # What needs you

    ace request list --quiet
    # Their ids, one per line

### `ace request show [REQUEST]`

One request in full: what it asks and its choices.

- `REQUEST`: A request id, or at least 6 characters of one; picked on a terminal when omitted

### `ace request allow [REQUEST] [flags]`

Allow a pending approval or plan.

- `REQUEST`: A request id, or at least 6 characters of one; picked on a terminal when omitted

- `--thread THREAD`: The thread whose one open request to answer
- `--always`: Allow it from now on, where the request offers that
- `--option ID`: One of the request's own options
- `--idempotency-key KEY`: Run this mutation at most once; retry with the same key

    ace request allow
    # Pick one of the open requests

    ace request allow i_4b1d0e --always
    # Allow it from now on

### `ace request deny [REQUEST] [flags]`

Deny a pending approval, plan or question.

- `REQUEST`: A request id, or at least 6 characters of one; picked on a terminal when omitted

- `--thread THREAD`: The thread whose one open request to answer
- `--option ID`: One of the request's own options
- `--feedback TEXT`: Why, sent back to the agent (plans and questions)
- `--idempotency-key KEY`: Run this mutation at most once; retry with the same key

### `ace request answer [REQUEST] [TEXT|-] [flags]`

Answer an agent's question.

Pick choices with --choice (QUESTION=ID when it asks several), or type an answer where the question takes one. On a terminal, missing answers are asked for.

- `REQUEST`: A request id, or at least 6 characters of one; picked on a terminal when omitted
- `TEXT`: A typed answer; - reads stdin

- `--thread THREAD`: The thread whose one open request to answer
- `--choice ID`: A choice, or QUESTION=ID; repeat for more
- `--idempotency-key KEY`: Run this mutation at most once; retry with the same key

    ace request answer i_4b1d0e --choice postgres
    # Pick a choice

    ace request answer i_4b1d0e "Use the staging bucket"
    # Type the answer

### `ace project list [flags]`

Your projects.

- `--limit N`: At most N results
- `--after CURSOR`: The page after this cursor (from the last page's next)

### `ace project show [PROJECT]`

One project: its folder, git and threads.

- `PROJECT`: A project id, name or path; this folder when omitted

### `ace project add [PATH] [flags]`

Register a folder as a project.

- `PATH`: The folder; this one when omitted

- `--idempotency-key KEY`: Run this mutation at most once; retry with the same key

### `ace project rename PROJECT NAME [flags]`

Rename a project.

- `PROJECT`: A project id, name or path
- `NAME`: Its new name

- `--idempotency-key KEY`: Run this mutation at most once; retry with the same key

### `ace project remove PROJECT [flags]`

Stop tracking a project; its files stay.

- `PROJECT`: A project id, name or path

- `--stop-threads`: Stop its running threads first
- `--idempotency-key KEY`: Run this mutation at most once; retry with the same key

### `ace project open [PROJECT] [flags]`

Open a project in the app.

- `PROJECT`: A project id, name or folder; this folder when omitted

- `--web`: Open the web app, not the desktop app
- `--idempotency-key KEY`: Run this mutation at most once; retry with the same key

Shortcut: `ace open`.

## This machine

### `ace daemon start`

Run the daemon in this terminal.

The desktop app and the login service run this. It stays in the foreground until stopped.

Shortcut: `ace start`.

### `ace daemon serve`

Run the daemon with a headless browser.

Shortcut: `ace serve`.

### `ace daemon stop`

Stop the daemon and wait for its cleanup.

Shortcut: `ace stop`.

### `ace daemon status`

The daemon's health.

### `ace daemon logs [flags]`

The daemon's recent log.

One line per record. With --follow it keeps printing; with --json it prints the records as JSON (one line each with --follow).

- `-f, --follow`: Keep printing as it changes; JSON Lines with --json
- `--limit N`: At most N results

Shortcut: `ace logs`.

    ace logs --limit 20
    # The last 20 records

    ace logs --follow --json
    # Records as JSON Lines, as they come

### `ace daemon token`

This machine's host token.

### `ace service install [flags]`

Run ace at login (launchd, systemd or Task Scheduler).

- `--linger`: Keep running after logout (Linux)

### `ace service uninstall`

Stop running ace at login.

### `ace service start`

Start the login service.

### `ace service stop`

Stop the login service.

### `ace service status`

Whether ace runs at login.

### `ace storage usage`

What ace's data uses on disk.

### `ace storage plan [flags]`

Plan a cleanup to review, without removing anything.

- `--threads`: Settled threads' history
- `--worktrees`: Worktrees of settled threads
- `--artifacts`: Screenshots, recordings and other artifacts
- `--logs`: Old logs
- `--attachments`: Attached files
- `--caches`: Caches ace can rebuild
- `--older-than DURATION`: Only what's older than this, like 30d
- `--force-item ID`: Also remove this protected item from the plan (needs --dry-run first)
- `--retention @FILE`: Days to keep per kind, from a JSON file

    ace storage plan --logs --older-than 14d
    # Logs older than two weeks

    ace storage plan --retention @keep.json
    # Your own retention

### `ace storage clean [flags]`

Plan a cleanup, show it, ask, then apply it.

On a terminal it asks before removing anything. Anywhere else it needs --yes, or --dry-run to only show the plan.

- `--threads`: Settled threads' history
- `--worktrees`: Worktrees of settled threads
- `--artifacts`: Screenshots, recordings and other artifacts
- `--logs`: Old logs
- `--attachments`: Attached files
- `--caches`: Caches ace can rebuild
- `--older-than DURATION`: Only what's older than this, like 30d
- `--force-item ID`: Also remove this protected item from the plan (needs --dry-run first)
- `--retention @FILE`: Days to keep per kind, from a JSON file
- `--dry-run`: Show the plan; change nothing

    ace storage clean --logs --older-than 30d
    # Old logs

    ace storage clean --threads --dry-run
    # See what would go

    ace storage clean --caches --yes
    # From a script

### `ace storage apply PLAN [flags]`

Apply a reviewed cleanup plan.

- `PLAN`: The plan id ace storage plan printed

- `--revision REVISION`: The plan revision you reviewed

### `ace storage status PLAN`

Where a cleanup plan stands.

- `PLAN`: The plan id ace storage plan printed

### `ace storage compact [flags]`

Give the database's free space back to the disk.

- `--abandon ID`: Give up a compaction that's stuck

### `ace config list`

Every setting and its value.

### `ace config get [KEY]`

One setting: its value, what it does and what it takes.

- `KEY`: A setting, like threads.useWorktree (ace config list shows them all)

### `ace config set KEY VALUE`

Change a setting.

- `KEY`: A setting, like threads.useWorktree (ace config list shows them all)
- `VALUE`: Its new value; @FILE for a JSON one

    ace config set threads.useWorktree off
    # Threads start in the project

    ace config set providers.default claude
    # New threads use Claude

    ace config set retention-days 60
    # Keep idle data for 60 days

### `ace config unset KEY`

Put a setting back to its default.

- `KEY`: A setting, like threads.useWorktree (ace config list shows them all)

### `ace doctor [flags]`

Check ace, then repair what's broken.

Works with the daemon down. On a terminal it offers a checklist of repairs, and triage when findings remain.

- `--fix`: Apply the recommended repairs
- `--dry-run`: Plan repairs without running them
- `--all`: Run every check, not only the quick ones
- `--provider PROVIDER`: The agent to hand it to: claude, codex, cursor or opencode

### `ace doctor bundle PATH [flags]`

Write a redacted support bundle.

- `PATH`: Where to write it

- `--include-threads`: Include thread transcripts

### `ace triage [flags]`

Hand what's broken to an agent, with the facts it needs.

Writes what an agent needs to know about this machine to a folder, then starts the agent there. Works with ace broken.

- `--provider PROVIDER`: The agent to hand it to: claude, codex, cursor or opencode
- `--print`: Print the playbook instead of starting

## Providers and access

### `ace provider list`

Installed provider CLIs and whether they're ready.

    ace provider list
    # Which agents are ready

### `ace provider show PROVIDER`

One provider: its CLI, sign-in and accounts.

- `PROVIDER`: codex, claude, cursor, opencode, antigravity or pi

    ace provider show codex
    # Codex's state

### `ace provider capabilities`

Providers, models, permission modes and ace's tools, in full.

    ace provider capabilities --json
    # Everything, for a script

### `ace provider login PROVIDER [flags]`

Sign a provider CLI in with its own login.

Starts the provider's own sign-in and prints the address and code to finish it in a browser. A provider that asks which service to connect takes --choice; without one, a person at a terminal picks from the list.

- `PROVIDER`: codex, claude, cursor, opencode, antigravity or pi

- `--account ACCOUNT`: Which of the provider's accounts
- `--choice ID`: The service to connect, when the CLI asks

    ace provider login codex
    # Sign Codex in

    ace provider login opencode --choice anthropic
    # Connect a service

### `ace provider account list`

Provider accounts ace knows.

    ace provider account list
    # Every provider account

### `ace provider account add PROVIDER ID HOME LABEL [flags]`

Add a provider account from its home folder.

- `PROVIDER`: codex, claude, cursor, opencode, antigravity or pi
- `ID`: An id for the account
- `HOME`: The provider's home folder for it
- `LABEL`: A name you'll recognise

- `--console`: A console (API) account

    ace provider account add codex work ~/.codex-work Work
    # A second Codex account

### `ace provider account show ID`

One provider account, its sign-in checked now.

- `ID`: The account id

    ace provider account show work
    # Is it signed in

### `ace provider account discover`

Find provider accounts already on this machine.

    ace provider account discover
    # Homes ace could add

### `ace model list [flags]`

Models you can pick, by provider.

- `--provider PROVIDER`: codex, claude, cursor, opencode, antigravity or pi
- `--account ACCOUNT`: Which of the provider's accounts
- `--limit N`: At most N results

    ace model list
    # Every model

    ace model list --provider claude --quiet
    # Claude's model ids

### `ace account status`

Whether this machine is signed in to ace, and as whom.

    ace account
    # Who this machine is signed in as

### `ace account login [flags]`

Sign this machine in to your ace account.

Prints an address to open in a browser, then waits until the sign-in finishes there.

- `--origin URL`: Another ace account server

Shortcut: `ace login`.

    ace login
    # Sign in

### `ace account logout`

Sign this machine out of its ace account.

Shortcut: `ace logout`.

    ace logout
    # Sign out

### `ace account machine-code set [CODE|-]`

Set the code account devices enter once.

Pass - to read the code from stdin. Without it, a terminal asks for it without echo; nothing else is read.

- `CODE`: The code; asked without echo when omitted

    ace account machine-code set -
    # Read it from stdin

### `ace account machine-code clear`

Clear the machine code.

    ace account machine-code clear
    # Clear it

### `ace machine list`

Machines this one is linked to, and whether each answers.

Agents here reach these by name as `machine`. Link one in the app's Fleet page.

    ace machine list
    # Your linked machines

### `ace device list`

Paired devices.

    ace device list
    # What's paired

### `ace device pair [SCOPES] [flags]`

A single-use link and QR code to pair a device.

- `SCOPES`: Comma-separated scopes; the defaults when omitted

- `--label NAME`: A name for the device
- `--ttl DURATION`: How long the link works: 5m, 1h, 24h or 7d
- `--device-ttl DURATION`: How long the device keeps access: 1d, 7d or 30d

    ace device pair --label Phone
    # Pair a phone

### `ace device revoke DEVICE`

End a device's access.

- `DEVICE`: The device id

    ace device revoke d_41c0
    # Revoke a device

### `ace remote list`

Remote profiles, and which one is in use.

    ace remote list
    # Profiles

### `ace remote add [NAME] [ORIGIN] [flags]`

Add a remote machine, from a pairing link or by hand.

With --link, redeems a pairing link from ace device pair on the other machine. By hand, pass ORIGIN with --fingerprint, --device and --token-file.

- `NAME`: A name for the profile
- `ORIGIN`: Its https origin, when adding by hand

- `--link URL`: A pairing link from ace device pair; - reads stdin
- `--fingerprint PIN`: Its public-key SHA-256, by hand
- `--device ID`: This device's id there, by hand
- `--token-file PATH`: A file holding the device token, by hand
- `--name NAME`: What the other machine calls this one

    ace remote add studio --link https://…
    # From a pairing link

### `ace remote use NAME`

Send every later command to this remote (local for this machine).

- `NAME`: The profile

    ace remote use local
    # Back to this machine

### `ace remote remove NAME`

Forget a remote profile.

- `NAME`: The profile

    ace remote remove studio
    # Forget it

### `ace mcp list`

Outside MCP clients' access.

    ace mcp list
    # Every grant

### `ace mcp add [flags]`

Let an outside MCP client use ace, and print its setup.

- `--scope SCOPE`: read or operate
- `--allow SCOPE,…`: Exactly these scopes
- `--ttl DURATION`: 30m, 12h, 30d or never
- `--project PROJECT,…`: Only these projects
- `--name NAME`: A name for the client

    ace mcp add --scope read --ttl 30d
    # A read-only client

### `ace mcp revoke GRANT`

End an outside client's access.

- `GRANT`: The grant id

    ace mcp revoke g_7c1e
    # Revoke a grant

### `ace mcp request list`

Outside clients asking to sign in, with their match codes.

    ace mcp request list
    # Pending sign-ins

### `ace mcp request allow REQUEST [flags]`

Let a client in, once its match code matches the one it shows.

- `REQUEST`: The sign-in request id

- `--ttl DURATION`: 30m, 12h, 30d (the default) or never
- `--project PROJECT,…`: Only these projects

    ace mcp request allow r_3f1a
    # Allow a sign-in

### `ace mcp request deny REQUEST`

Turn a client's sign-in away.

- `REQUEST`: The sign-in request id

    ace mcp request deny r_3f1a
    # Deny a sign-in

## Spade and the market

### `ace spade skill import FROM [flags]`

Keep a SKILL.md folder, or one in a git repository, as a Spade skill.

The folder must meet the Agent Skills specification: SKILL.md with name (the folder's name: lower-case letters, digits and single hyphens, at most 64) and description (at most 1,024 characters), and license, compatibility, metadata and allowed-tools as the specification has them. It passes the market's skill checks too: no secrets, within a skill's limits. Every file is kept as it came; hidden files are left out. Fields Spade doesn't use are kept and listed. allowed-tools grants nothing: Spade's gate still decides each call the skill's instructions lead to.

- `FROM`: The skill's folder, or a git address (https, ssh or user@host:path)

- `--path FOLDER`: With a git address, the skill's folder in the repository; its root otherwise
- `--git`: Read FROM as a git repository, a local one's path included
- `--replace`: Replace a skill written in Spade with the same name

    ace spade skill import ./triage-mail
    # A folder on this machine

    ace spade skill import https://github.com/example/skills --path triage-mail
    # One skill from a repository's folder

### `ace spade skill export SKILL [DIR]`

Write a Spade skill as a SKILL.md folder that meets the Agent Skills specification.

The folder is DIR/<name>, which must not exist yet. SKILL.md keeps the specification's fields and its body as they were; fields the specification doesn't define move under metadata as spade.field.<name>, and metadata.spade.version and metadata.spade.source say how it was written and where the skill came from. Importing the folder again gives back the same skill. A plugin's skills export with their plugin.

- `SKILL`: The skill's name or id
- `DIR`: Where to write its folder; this folder when omitted

### `ace spade status`

Whether Spade is on, and how it is.

### `ace spade on`

Turn Spade on.

While Settings › Beta hides Spade, this turns that on too: it asks once on a terminal, and needs --yes anywhere else.

### `ace spade off`

Turn Spade off; its data is kept.

### `ace spade bot list`

Spade's bots, and what each is doing.

### `ace spade bot show BOT`

One bot: its task, model and latest message.

- `BOT`: A bot's id or name

### `ace spade move BOT [flags]`

Move a bot to another of your machines, with everything it knows.

The bot keeps its id, history, notes, files and routines (they arrive paused). Endpoint keys, webhook secrets and what you allowed it (grants, Full access, apps, plugins) stay on each machine: give them again there. The machine it goes to takes it only with your say there, so --target-remote names how to reach it. Spade's main bot can move too; the machine it moves to becomes where Spade lives.

- `BOT`: A bot's id or name

- `--to MACHINE`: The machine: its name or host id
- `--target-remote PROFILE`: How to reach that machine for your say there: a remote profile, or here

    ace spade move research --to studio --target-remote studio
    # Move Research to the studio, saying so there through its remote profile

### `ace spade chat [BOT] [TEXT|-]`

Talk with a bot (Spade's main bot by default).

With TEXT it sends one message and prints the reply. Without it, on a terminal, it is a conversation: type a line, read the answer, Ctrl-C to leave.

- `BOT`: A bot's id or name; Spade's main bot when omitted
- `TEXT`: One message to send; - reads it from stdin

    ace spade chat
    # A conversation with Spade

    ace spade chat writer "Draft the release notes"
    # One message

### `ace bot running`

Every bot: what it does now, its spend today, its network and next wake.

One row per bot, its workers under it, in the order the app's Running page shows: needs you, working, failed, sleeping, paused, then idle.

### `ace bot stop BOT`

End a bot's work now, and its workers'; its routines stay on.

- `BOT`: A bot's id or name

### `ace bot pause BOT`

Stop a bot and hold it: nothing of it fires until you resume it.

Its wakes are kept and its routines' slots wait; messages to it wait too. It holds through a restart of Spade.

- `BOT`: A bot's id or name

### `ace bot resume BOT`

End a pause: what came due fires once, and what waited is answered.

- `BOT`: A bot's id or name

### `ace bot unarchive BOT`

Bring back a bot Undo archived: the routines that were on come back on.

Nothing of it was deleted. Its routines that were on run again from their next time; the ones that were paused stay paused.

- `BOT`: A bot's id or name

### `ace feature list`

Beta features and whether each is on.

### `ace feature on FEATURE`

Turn a Beta feature on.

- `FEATURE`: spade or marketplace

### `ace feature off FEATURE`

Turn a Beta feature off.

- `FEATURE`: spade or marketplace

### `ace automation list`

Your automations.

### `ace automation show AUTOMATION`

One automation: its trigger, next run and last run.

- `AUTOMATION`: The automation id

### `ace automation run AUTOMATION [flags]`

Run an automation now.

- `AUTOMATION`: The automation id

- `--variables @FILE`: Its variables, from a JSON file
- `--message TEXT`: Extra instructions for this run only
- `--idempotency-key KEY`: Run this mutation at most once; retry with the same key

    ace automation run nightly
    # Now

    ace automation run release --variables @vars.json
    # With variables

### `ace automation create DEFINITION [flags]`

Save an automation from a JSON definition.

- `DEFINITION`: @FILE: the automation as JSON (ace automation show ID --json shows one)

- `--idempotency-key KEY`: Run this mutation at most once; retry with the same key

### `ace automation remove AUTOMATION [flags]`

Delete an automation.

- `AUTOMATION`: The automation id

- `--idempotency-key KEY`: Run this mutation at most once; retry with the same key

### `ace bot init [NAME] [flags]`

Make a package folder: bot.json, a skill, a card, a scenario test and a README.

Every file is valid as written: the folder passes ace bot check and ace bot test before you change a word. Templates: blank (it answers when you write to it), watcher (a schedule, a network effect and a card), club-member (answers when mentioned in a thread or club). With --from, one of your own bots becomes the package: its task, face, personality, routines as triggers, the skills and apps it uses, and each effect its calls had, declared with a TODO where you say why. Its conversation, notes, knowledge, workspace files, keys and grants stay with the bot.

- `NAME`: The bot's name, like "Fare watcher"; with --from, the bot's own name when omitted

- `--template T`: What it starts as: blank, watcher or club-member
- `--from BOT`: One of your bots, by name or id, to start from
- `--spade DIR`: With --from: a development Spade's data folder, reached directly instead of through ace
- `--path PATH`: Where to make it; ./<name> otherwise

    ace bot init "Fare watcher" --template watcher
    # A bot that checks on a schedule and shows a card

    ace bot init --from "Release notes"
    # Your bot Release notes as a package folder to finish and publish

### `ace bot check [PATH] [flags]`

The market's checks on a package, with every problem at its place; no account.

The same reader Spade and the market use. Problems print as path: sentence and exit 1. Warnings (a thin why on an effect, a TODO left to write, no scenario tests) don't fail the check. With --against, the version other bots call is compared too: a change to a contract that would break them (a field gone or newly required, less text taken, an output that may hold what callers never saw) is refused, since a breaking change takes a new name.

- `PATH`: The package's folder; this one when omitted

- `--against PATH`: The version other bots call (its folder or bot.json): a contract change that breaks them is refused

### `ace bot test [PATH] [flags]`

Run the package's scenario tests on Spade's engine with a scripted model, offline.

Each scenario in tests/ runs on a throwaway Spade with spade-testkit's fake model: no network, no real model, nothing of yours. Needs Spade's program: the one this ace ships, or ACE_SPADE_BIN. With --cases, one of your bots' kept runs (Keep as a test) replay instead, on the version in PATH or the one the bot runs, through your Spade: free on the recorded steps, every outside call answered from the recording. --model replays them on one of your models, at your cost, said first.

- `PATH`: The package's folder; this one when omitted

- `--cases BOT`: Replay this bot's kept runs (by name or id) instead of the scenarios
- `--model ROLE`: With --cases: replay on a model (current, a role like review, or endpoint/model), at your cost
- `--spade DIR`: With --cases: a development Spade's data folder, reached directly instead of through ace

    ace bot test --cases "Fare watcher" .
    # Does this folder's version still do what Fare watcher's kept runs did?

### `ace bot dev [PATH] [flags]`

Install the package here as a development bot, and update it on every save.

It installs once, linked to the local package of its name (local/<name>), its routines paused, and shows Development in your list. Each save is checked and applied as an update at the bot's next quiet moment. A save that asks for more (an effect, a trigger kind, an app) asks you again. The bot belongs to the folder: renaming it in bot.json renames the same bot, and another folder makes another bot. Ctrl-C to stop watching; the bot stays.

- `PATH`: The package's folder; this one when omitted

- `--spade DIR`: A development Spade's data folder, reached directly instead of through ace
- `--once`: Install or update once, then stop

### `ace bot publish [PATH] [flags]`

Check and test the package, then publish it free: ace market publish spade-bot PATH.

Before uploading it reads the latest version published in the market (ACE_MARKET_URL for a development one) and refuses a change to a contract that would break the bots calling it; a breaking change takes a new name. The market's signer refuses the same change.

- `PATH`: The package's folder; this one when omitted

- `--version VERSION`: The version to publish, such as 1.0.0
- `--against PATH`: The version other bots call (its folder or bot.json): a contract change that breaks them is refused
- `--name NAME`: The entry's name; the folder's otherwise
- `--changelog TEXT|-|@FILE`: What changed in this version
- `--draft`: Stop at the draft and print its id
- `--unlisted`: Reached by its link, not by search
- `--wait`: Watch until it is live or blocked

### `ace market discover`

What's featured, new and trending, and how to find more.

Every market command goes through this machine's daemon, so its sources, signature checks and ace account are used. Maintainer tools: ace help market-maintainer

### `ace market search [QUERY…] [flags]`

Search the market.

- `QUERY`: Words to look for; everything when omitted

- `--type TYPE`: suit, spade-skill, spade-plugin or spade-bot
- `--category CATEGORY`: One category, such as dev-tools
- `--source SOURCE`: market or git:ID
- `--limit N`: At most N entries (50)

    ace market search linear --type spade-plugin
    # Plugins

### `ace market show REF [flags]`

An entry: what it is, who publishes it, its versions; or a publisher's page.

- `REF`: TYPE/NAME or @HANDLE

- `--source SOURCE`: market or git:ID

### `ace market install REF [flags]`

Read an entry's review, then install it.

The review prints first: what it is, who published it, what it can run and reach, and what the scan found. Without a terminal, --yes installs with the review's defaults (no routines started). From an agent, installing is the person's: ace asks them in the thread.

- `REF`: TYPE/NAME, such as suit/dusk-harbor

- `--version VERSION`: This version, not the newest
- `--source SOURCE`: market or git:ID

### `ace market update [REF…] [flags]`

Read what changed, then update installed entries.

- `REF`: TYPE/NAME; every update with --all

- `--all`: Every entry with an update

### `ace market remove REF`

Remove an installed entry.

- `REF`: TYPE/NAME, such as suit/dusk-harbor

### `ace market restore REF`

Turn a withdrawn or turned-off entry back on, from its pinned files.

- `REF`: TYPE/NAME, such as suit/dusk-harbor

### `ace market installed [flags]`

What's installed from the market.

- `--updates`: Only entries with an update

### `ace market source list`

Where entries come from.

### `ace market source add ADDRESS`

Add a git catalog as a source.

- `ADDRESS`: The catalog's https address

### `ace market source remove SOURCE`

Remove a source.

- `SOURCE`: The source's id: market or git:ID

### `ace market source on SOURCE`

Turn a source on.

- `SOURCE`: The source's id: market or git:ID

### `ace market source off SOURCE`

Turn a source off.

- `SOURCE`: The source's id: market or git:ID

### `ace market source refresh [SOURCE]`

Read sources again now.

- `SOURCE`: One source; every source when omitted

### `ace market report REF [flags]`

Report an entry to ace's maintainers.

- `REF`: TYPE/NAME or TYPE/NAME@VERSION

- `--reason REASON`: What's wrong
- `--note TEXT`: What you saw

### `ace market check [PATH] [flags]`

The market's checks on a folder, before publishing.

Runs here, with no account and no daemon.

- `PATH`: The folder; this one when omitted

- `--type TYPE`: suit, spade-skill, spade-plugin or spade-bot
- `--name NAME`: The entry's name; the folder's otherwise

### `ace market publish TYPE PATH [flags]`

Upload a version as a draft, read its scan, then publish it.

- `TYPE`: suit, spade-skill, spade-plugin or spade-bot
- `PATH`: A folder, or one of your Suits by id

- `--name NAME`: The entry's name; the folder's otherwise
- `--version VERSION`: The version to publish, such as 1.2.0
- `--changelog TEXT`: What changed: the text, - for stdin, or @FILE
- `--draft`: Stop at the draft and print its id
- `--unlisted`: Reached by its link, not by search
- `--wait`: Watch until it is live, or blocked

    ace market publish suit ./dusk-harbor --version 1.2.0 --draft
    # A draft and its scan

### `ace market draft list`

Your drafts.

### `ace market draft show DRAFT`

One draft and its scan.

- `DRAFT`: The draft's id (drf_…)

### `ace market draft update DRAFT [flags]`

Change a draft's version, changelog or files.

- `DRAFT`: The draft's id (drf_…)

- `--version VERSION`: Another version
- `--changelog TEXT`: What changed: the text, - for stdin, or @FILE
- `--from PATH`: New files from this folder

### `ace market draft publish DRAFT [flags]`

Publish a draft.

- `DRAFT`: The draft's id (drf_…)

- `--wait`: Watch until it is live, or blocked

### `ace market draft delete DRAFT`

Delete a draft.

- `DRAFT`: The draft's id (drf_…)

### `ace market status [REF]`

Your entries, and where each version is.

- `REF`: One entry: TYPE/NAME

### `ace market versions REF`

One entry's versions with status, changelog and deprecation.

- `REF`: TYPE/NAME, such as suit/dusk-harbor

### `ace market describe REF [flags]`

Change an entry's listing words.

- `REF`: TYPE/NAME, such as suit/dusk-harbor

- `--title TEXT`: Its title
- `--line TEXT`: Its one line
- `--description TEXT`: Its description, or @FILE
- `--category CATEGORY`: A category (up to 3)
- `--keyword WORD`: A keyword (up to 16)
- `--link LABEL=URL`: A link (up to 5)

### `ace market changelog REF [TEXT|-]`

Set one version's changelog.

- `REF`: TYPE/NAME@VERSION
- `TEXT`: The text, - for stdin, or @FILE

### `ace market latest REF [VERSION] [flags]`

Which version the listing shows.

- `REF`: TYPE/NAME, such as suit/dusk-harbor
- `VERSION`: The version; --newest follows the newest

- `--newest`: Follow the newest live version

### `ace market deprecate REF [flags]`

Deprecate a version, with a note installs show.

- `REF`: TYPE/NAME@VERSION

- `--note TEXT`: Why, and what to use instead
- `--clear`: Clear the deprecation

### `ace market visibility REF VISIBILITY`

Listed in search, or reached by its link only.

- `REF`: TYPE/NAME, such as suit/dusk-harbor
- `VISIBILITY`: listed or unlisted

### `ace market archive REF`

Hide an entry from search; installs keep working.

- `REF`: TYPE/NAME, such as suit/dusk-harbor

### `ace market unarchive REF`

List an archived entry again.

- `REF`: TYPE/NAME, such as suit/dusk-harbor

### `ace market withdraw REF [flags]`

Withdraw a version, or every version, from everyone's devices.

- `REF`: TYPE/NAME@VERSION, or TYPE/NAME for all

- `--reason TEXT`: Why; devices show it

### `ace market transfer REF [flags]`

Offer an entry to another publisher.

- `REF`: TYPE/NAME, such as suit/dusk-harbor

- `--to @HANDLE`: Who receives it

### `ace market transfer accept TRANSFER`

Accept a transfer offered to you.

- `TRANSFER`: The transfer's id (trf_…)

### `ace market transfer decline TRANSFER`

Decline a transfer offered to you.

- `TRANSFER`: The transfer's id (trf_…)

### `ace market delete REF`

Delete an entry that only ever had drafts or was never listed.

- `REF`: TYPE/NAME, such as suit/dusk-harbor

### `ace market signals REF`

Downloads, installs and reports for one entry.

- `REF`: TYPE/NAME, such as suit/dusk-harbor

### `ace market appeal REF [flags]`

Ask ace's maintainers to look again at a held or blocked version.

- `REF`: TYPE/NAME@VERSION

- `--note TEXT`: What you changed, or why it's fine
- `--replacement VERSION`: A newer version that answers it

### `ace market profile show`

Your publisher profile.

### `ace market profile create [flags]`

Make your publisher profile.

- `--handle HANDLE`: Your handle, such as arpan
- `--name NAME`: The name people see
- `--bio TEXT`: A line about you

### `ace market profile edit [flags]`

Change your profile's name or bio.

- `--name NAME`: The name people see
- `--bio TEXT`: A line about you

### `ace market profile handle HANDLE`

Change your handle.

- `HANDLE`: The new handle

### `ace market profile avatar FILE`

Set your profile picture.

- `FILE`: A PNG, JPEG or WebP, at most 1 MB

### `ace market profile pins [REF…]`

Pin up to six of your entries on your page.

- `REF`: TYPE/NAME, in order

### `ace market verification show`

Your verification and its proofs.

### `ace market verification apply [flags]`

Apply for ace's verified mark.

- `--domain DOMAIN`: A domain you own
- `--github LOGIN`: Your GitHub login

### `ace market verification check`

Check your proofs again now.

## Agent tools

### `ace browser screenshot [THREAD] [flags]`

A screenshot of a thread's browser, saved to a file.

- `THREAD`: The thread whose browser; defaults to ACE_THREAD_ID in an agent's shell

- `--url URL`: Open this page first
- `--output PATH`: Where to write the file
- `--duration DURATION`: How long to record, e.g. 5s

    ace browser screenshot --url http://localhost:5173 --output page.png
    # From an agent's shell

### `ace browser record [THREAD] [flags]`

An MP4 of a thread's browser, saved to a file.

- `THREAD`: The thread whose browser; defaults to ACE_THREAD_ID in an agent's shell

- `--url URL`: Open this page first
- `--output PATH`: Where to write the file
- `--duration DURATION`: How long to record, e.g. 5s

    ace browser record --duration 10s
    # Ten seconds of it

### `ace sim list [flags]`

Simulators and emulators on this machine.

- `--thread THREAD`: The thread; defaults to ACE_THREAD_ID in an agent's shell

    ace sim list
    # Devices, from an agent's shell

### `ace sim start SIM [flags]`

Take a simulator for the thread, boot it and show it live.

- `SIM`: The simulator or emulator

- `--thread THREAD`: The thread; defaults to ACE_THREAD_ID in an agent's shell
- `--no-boot`: Don't boot it

    ace sim start ios-17
    # Take and boot a simulator

### `ace sim stop SIM [flags]`

Release a simulator when you finish.

- `SIM`: The simulator or emulator

- `--thread THREAD`: The thread; defaults to ACE_THREAD_ID in an agent's shell

    ace sim stop ios-17
    # Release it

### `ace sim ui SIM [NAME] [flags]`

Read the screen; actionable elements carry refs like @e3.

- `SIM`: The simulator or emulator
- `NAME`: Only elements named this

- `--thread THREAD`: The thread; defaults to ACE_THREAD_ID in an agent's shell
- `--text TEXT`: Only elements with this text
- `--role ROLE`: Only elements with this role
- `--limit N`: At most N results
- `--max-depth N`: How deep to read
- `--max-nodes N`: How many elements to read

    ace sim ui ios-17 --text Login
    # Find the login button's ref

### `ace sim act SIM ACTION… [flags]`

Tap, type, swipe, press keys or open apps (ace help sim act).

Refs first: ace sim ui, act on a ref, ui again after the screen changes. Coordinates are the fallback. A ref is re-checked before acting: stale_ref if it has gone.

  tap @e3 | tap X Y                       tap an element, or a point
  type @e3 TEXT                           focus the element, then type (no ref: the focused field)
  press|focus|setValue|scroll|select|expand @e3 [--value V]
  long_press @e3|X Y [--duration MS]
  swipe X Y TOX TOY [--duration MS]
  key home|back|enter|rotate|power|recents|volumeUp|volumeDown|action|side
  open_app ID | open_url URL | install PATH | record_start | record_stop
  clipboard_get | clipboard_set TEXT      read the clipboard, or set it without pasting
  posture closed|partiallyOpen|open       fold or unfold a foldable device

- `SIM`: The simulator or emulator
- `ACTION`: What to do, then its arguments

- `--thread THREAD`: The thread; defaults to ACE_THREAD_ID in an agent's shell
- `--value VALUE`: The value for setValue
- `--duration MS`: How long to press or swipe

    ace sim act ios-17 tap @e3
    # Tap an element by its ref

    ace sim act ios-17 type @e5 hello
    # Type into a field

### `ace sim screenshot SIM [flags]`

A JPEG of the screen.

- `SIM`: The simulator or emulator

- `--thread THREAD`: The thread; defaults to ACE_THREAD_ID in an agent's shell
- `--output PATH`: Where to write the file

    ace sim screenshot ios-17 --output shot.jpg
    # Save the screen

### `ace sim logs SIM [flags]`

The device's recent log.

- `SIM`: The simulator or emulator

- `--thread THREAD`: The thread; defaults to ACE_THREAD_ID in an agent's shell
- `--limit N`: At most N results

    ace sim logs ios-17 --limit 50
    # The last 50 log lines

### `ace cloud codex exec PROMPT|- [flags]`

Start a Codex Cloud task.

- `PROMPT`: What to do; - reads stdin

- `--env ENV_ID`: The Codex Cloud environment
- `--attempts N`: Attempts, 1 to 4
- `--branch BRANCH`: The branch to start from
- `--limit N`: At most N results
- `--cursor CURSOR`: The page after this cursor
- `--attempt N`: Which attempt
- `--idempotency-key KEY`: Run this mutation at most once; retry with the same key

    ace cloud codex exec PROMPT
    # Start a Codex Cloud task

### `ace cloud codex list [flags]`

Codex Cloud tasks.

- `--env ENV_ID`: The Codex Cloud environment
- `--attempts N`: Attempts, 1 to 4
- `--branch BRANCH`: The branch to start from
- `--limit N`: At most N results
- `--cursor CURSOR`: The page after this cursor
- `--attempt N`: Which attempt
- `--idempotency-key KEY`: Run this mutation at most once; retry with the same key

    ace cloud codex list
    # Codex Cloud tasks

### `ace cloud codex status TASK [flags]`

A Codex Cloud task's state.

- `TASK`: The Codex Cloud task id

- `--env ENV_ID`: The Codex Cloud environment
- `--attempts N`: Attempts, 1 to 4
- `--branch BRANCH`: The branch to start from
- `--limit N`: At most N results
- `--cursor CURSOR`: The page after this cursor
- `--attempt N`: Which attempt
- `--idempotency-key KEY`: Run this mutation at most once; retry with the same key

    ace cloud codex status TASK
    # A Codex Cloud task's state

### `ace cloud codex diff TASK [flags]`

A Codex Cloud task's diff.

- `TASK`: The Codex Cloud task id

- `--env ENV_ID`: The Codex Cloud environment
- `--attempts N`: Attempts, 1 to 4
- `--branch BRANCH`: The branch to start from
- `--limit N`: At most N results
- `--cursor CURSOR`: The page after this cursor
- `--attempt N`: Which attempt
- `--idempotency-key KEY`: Run this mutation at most once; retry with the same key

    ace cloud codex diff TASK
    # A Codex Cloud task's diff

### `ace cloud codex apply TASK [flags]`

Apply a Codex Cloud task's diff here.

- `TASK`: The Codex Cloud task id

- `--env ENV_ID`: The Codex Cloud environment
- `--attempts N`: Attempts, 1 to 4
- `--branch BRANCH`: The branch to start from
- `--limit N`: At most N results
- `--cursor CURSOR`: The page after this cursor
- `--attempt N`: Which attempt
- `--idempotency-key KEY`: Run this mutation at most once; retry with the same key

    ace cloud codex apply TASK
    # Apply a Codex Cloud task's diff here

## Old spellings

Each prints a notice on a terminal for two releases after the one it was replaced in, is a usage error naming the new command in the third, and is then removed.

| Old | New | Replaced in |
| --- | --- | --- |
| `ace threads list` | `ace thread list` | 0.0.24 |
| `ace thread read` | `ace thread show` | 0.0.24 |
| `ace task spawn` | `ace thread start` | 0.0.24 |
| `ace thread cancel` | `ace thread stop` | 0.0.24 |
| `ace thread interrupt` | `ace thread stop` | 0.0.24 |
| `ace task cancel` | `ace thread stop` | 0.0.24 |
| `ace kill-all` | `ace thread stop` | 0.0.24 |
| `ace task wait` | `ace thread wait` | 0.0.24 |
| `ace task status` | `ace thread status` | 0.0.24 |
| `ace thread approve` | `ace request allow` | 0.0.24 |
| `ace thread deny` | `ace request deny` | 0.0.24 |
| `ace add` | `ace project add` | 0.0.24 |
| `ace token` | `ace daemon token` | 0.0.24 |
| `ace clean` | `ace storage clean` | 0.0.24 |
| `ace clean apply` | `ace storage apply` | 0.0.24 |
| `ace clean status` | `ace storage status` | 0.0.24 |
| `ace support-bundle` | `ace doctor bundle` | 0.0.24 |
| `ace providers status` | `ace provider list` | 0.0.24 |
| `ace capabilities` | `ace provider capabilities` | 0.0.24 |
| `ace login codex` | `ace provider login` | 0.0.24 |
| `ace login claude` | `ace provider login` | 0.0.24 |
| `ace login cursor` | `ace provider login` | 0.0.24 |
| `ace login opencode` | `ace provider login` | 0.0.24 |
| `ace login antigravity` | `ace provider login` | 0.0.24 |
| `ace login pi` | `ace provider login` | 0.0.24 |
| `ace accounts list` | `ace provider account list` | 0.0.24 |
| `ace accounts add` | `ace provider account add` | 0.0.24 |
| `ace accounts status` | `ace provider account show` | 0.0.24 |
| `ace accounts discover` | `ace provider account discover` | 0.0.24 |
| `ace machine-code set` | `ace account machine-code set` | 0.0.24 |
| `ace machine-code clear` | `ace account machine-code clear` | 0.0.24 |
| `ace devices list` | `ace device list` | 0.0.24 |
| `ace pair` | `ace device pair` | 0.0.24 |
| `ace devices revoke` | `ace device revoke` | 0.0.24 |
| `ace pair redeem` | `ace remote add` | 0.0.24 |
| `ace mcp enroll` | `ace mcp add` | 0.0.24 |
| `ace features on` | `ace feature on` | 0.0.24 |
| `ace features off` | `ace feature off` | 0.0.24 |
| `ace marketplace check` | `ace market check` | 0.0.24 |
| `ace market keygen` | `ace market maintainer keygen` | 0.0.24 |
| `ace market sign` | `ace market maintainer sign` | 0.0.24 |
| `ace market review` | `ace market maintainer review` | 0.0.24 |
| `ace market feature` | `ace market maintainer feature` | 0.0.24 |
| `ace market revoke` | `ace market maintainer revoke` | 0.0.24 |
| `ace market reports` | `ace market maintainer reports` | 0.0.24 |
| `ace market collection` | `ace market maintainer collection` | 0.0.24 |
| `ace market publisher` | `ace market maintainer publisher` | 0.0.24 |
| `ace market block` | `ace market maintainer block` | 0.0.24 |
| `ace market block-file` | `ace market maintainer block-file` | 0.0.24 |
| `ace market block-pattern` | `ace market maintainer block-pattern` | 0.0.24 |
| `ace market appeals` | `ace market maintainer appeals` | 0.0.24 |
| `ace market verify` | `ace market maintainer verify` | 0.0.24 |
| `ace market unverify` | `ace market maintainer unverify` | 0.0.24 |
| `ace market official` | `ace market maintainer official` | 0.0.24 |
| `ace browser shot` | `ace browser screenshot` | 0.0.24 |

## Topics

### Human text, --json, --quiet and streams

```
Every command prints words for a person by default, piped or not.

  --json        exactly one JSON value on stdout: the command's data, or a CliError
                ({ok:false, status, code, error, hint}) when it fails. Progress and
                notices go to stderr. No colour codes, ever.
  --jq EXPR     --json filtered through the installed jq.
  --quiet, -q   only identifiers, one per line (thread ids, request ids, entry refs);
                actions print nothing. Errors still go to stderr.
  --follow, -f  keep printing as things change; JSON Lines with --json, ending in a
                record of type "outcome".
  --no-input    never ask anything; a missing argument is a usage error (exit 64).
  --color WHEN  auto, always or never. auto follows the terminal, NO_COLOR, FORCE_COLOR.

ace help COMMAND --schema prints a command's --json shape as JSON Schema.
ace help --json prints every command, flag and exit code.
```

### How agents running inside ace should call it

```
ace starts your session with ACE_THREAD_ID (your thread) and ACE_NO_INPUT=1, so
nothing ever waits for input and tools like ace sim and ace browser know your thread.

  - Check the exit code before reading the output. 2 means hand back to the person.
  - Use --json to parse, and human text to read: it is shorter.
  - 64 means the command line was wrong; the error names the argument and the fix.
  - 5 means ace doesn't know whether it ran: retry with the same --idempotency-key.
  - A missing prompt is read from stdin only when you pass -.
  - Waits never report done while any agent in a tree works or waits on a person.
  - Agents never answer requests. Approvals, questions to the person, plans and
    permissions are the person's: ace request allow|deny|answer, ace config set|unset and
    ace feature|spade on|off exit 2 (code person_only) from your shell. Hand back to the
    person instead; they answer in the app, on a paired device or in their own terminal.
  - In the market you may read, search, check, make and publish drafts, and read your
    status and versions. Everything else (installing, removing, withdrawing, transfers,
    sources, listings, visibility) is the person's and becomes a request in your thread
    (ace help publishing).
```

### Working on another machine

```
Pair another machine with ace device pair there, then here:

  ace remote add work --link URL   save it as a profile
  ace remote use work              every later command goes there
  ace thread list --remote work    or just one command
  ace remote use local             back to this machine

On a remote, --project takes a project id from ace project list; paths are refused.
```

### Publishing Suits, skills and bots to the market

```
  ace market check ./my-suit --type suit                 the market's checks, here
  ace market publish suit ./my-suit --version 1.2.0 --draft
                                                         a draft and its scan
  ace market draft publish DRAFT                         publish it
  ace market status                                      your entries and their versions
  ace market describe suit/my-suit --title "My Suit"     the listing's words

Publishing needs this machine signed in to your ace account (ace login). Withdrawing,
transferring, handle changes, editing a verified profile and verification ask you to sign
in again first (exit 2, code reauth, without a terminal).

From an agent (ACE_THREAD_ID set, or ace's market_publish tool), publishing follows your
provider's permissions. Withdraw, transfer, handle changes, deleting an entry, verified
profile edits, verification and installing are yours: ace asks you in the agent's thread
and the command exits 2 with code person_only and the request's id; --yes doesn't change
that. Settings › Beta › Ask me before agents publish makes every agent publish such a
request too.
```

### The market's maintainer tools

```
Maintainer tool: needs ACE_MARKET_SIGNER_TOKEN and a signing key.

ace market maintainer COMMAND talks to market.acehq.dev directly, never through the daemon
or an ace account, and sends the signer token there only. A development market must be
named with --dev-market URL (https, or http on this machine). --json and --jq work as
everywhere.

  keygen KEY_FILE [--id ID]            a signing key; prints its public half
  sign --key KEY_FILE                  re-scan, then sign, hold or block what waits
  review [TYPE/NAME@VERSION]           the queue, or one version: --show, --approve, --block
  feature TYPE/NAME…                   the featured list
  revoke HASH --reason TEXT            withdraw bytes wherever they're listed
  reports [resolve ID --state STATE]   open reports
  collection list|put|remove           curated collections
  publisher HANDLE --suspend|--restore|--withdraw-all
  block|block-file|block-pattern       the signed blocklist
  appeals | appeal ID --answer TEXT --approve|--keep
  verify|unverify HANDLE --reason TEXT
  official add|remove ACCOUNT

The old ace market VERB spellings still work for now.
```

### Using ace from scripts

```
  id=$(ace run "Fix the build" --quiet)        the new thread's id
  ace thread wait "$id" --tree --timeout 30m   exit 0 done, 1 failed, 2 needs you
  ace request list --quiet                     what's waiting, one id per line
  ace thread list --json --jq '.threads[].id'

Mutations take --idempotency-key KEY: the same key never runs twice, so a retry after
exit 5 is safe.
```
