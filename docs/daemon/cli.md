# The ace CLI

<!-- Generated from apps/daemon/src/cli/commands by `bun apps/daemon/scripts/cli-doc.ts`. Don't edit by hand. -->

Every command is `ace <noun> <verb> [ARGUMENTS] [FLAGS]` ([ADR 0176](../adr/0176-one-cli-grammar-interactive-home-and-market.md)).
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

- `--project PROJECT`: A project id, name or path

    ace thread list
    # Every thread

    ace thread list --project ace --json
    # One project's, as JSON

### `ace thread show THREAD`

One thread's transcript, requests and state.

- `THREAD`: A thread id

    ace thread show t_9f2c41
    # Read a thread

### `ace thread start [PROMPT|-] [flags]`

Start an agent on a prompt.

Registers the project when given a path, then starts a thread. Without a prompt on a terminal it asks for one; elsewhere pass the prompt or - to read it from stdin.

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

### `ace thread send THREAD [TEXT|-] [flags]`

Queue a message for when the agent's turn ends.

- `THREAD`: A thread id
- `TEXT`: The message; - reads stdin

- `--idempotency-key KEY`: Run this mutation at most once; retry with the same key

### `ace thread steer THREAD [TEXT|-] [flags]`

Send a message into the agent's current turn.

- `THREAD`: A thread id
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

- `THREAD`: A thread id

### `ace request allow [REQUEST] [flags]`

Allow a pending approval or plan.

- `REQUEST`: The request id

- `--thread THREAD`: The thread whose one open request to answer
- `--option ID`: One of the request's own options
- `--idempotency-key KEY`: Run this mutation at most once; retry with the same key

### `ace request deny [REQUEST] [flags]`

Deny a pending approval or plan.

- `REQUEST`: The request id

- `--thread THREAD`: The thread whose one open request to answer
- `--option ID`: One of the request's own options
- `--idempotency-key KEY`: Run this mutation at most once; retry with the same key

### `ace project list [flags]`

Your projects.

- `--limit N`: At most N results
- `--after CURSOR`: The page after this cursor (from the last page's next)

### `ace project add [PATH] [flags]`

Register a folder as a project.

- `PATH`: The folder; this one when omitted

- `--idempotency-key KEY`: Run this mutation at most once; retry with the same key

### `ace project rename PROJECT NAME [flags]`

Rename a project.

- `PROJECT`: The project id
- `NAME`: Its new name

- `--idempotency-key KEY`: Run this mutation at most once; retry with the same key

### `ace project remove PROJECT [flags]`

Stop tracking a project; its files stay.

- `PROJECT`: The project id

- `--stop-threads`: Stop its running threads first
- `--idempotency-key KEY`: Run this mutation at most once; retry with the same key

### `ace project open [PROJECT] [flags]`

Open a project in the app.

- `PROJECT`: A project id or a folder; this folder when omitted

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

### `ace provider capabilities`

Providers, models, permission modes and ace's tools, in full.

### `ace provider login PROVIDER [flags]`

Sign a provider CLI in with its own login.

- `PROVIDER`: codex, claude, cursor, opencode, antigravity or pi

- `--account ACCOUNT`: Which of the provider's accounts

### `ace provider account list`

Provider accounts ace knows.

### `ace provider account add PROVIDER ID HOME LABEL [flags]`

Add a provider account from its home folder.

- `PROVIDER`: codex, claude, cursor, opencode, antigravity or pi
- `ID`: An id for the account
- `HOME`: The provider's home folder for it
- `LABEL`: A name you'll recognise

- `--console`: A console (API) account

### `ace provider account show ID`

One provider account.

- `ID`: The account id

### `ace provider account discover`

Find provider accounts already on this machine.

### `ace account login [flags]`

Sign this machine in to your ace account.

- `--origin URL`: Another ace account server

Shortcut: `ace login`.

### `ace account logout`

Sign this machine out of its ace account.

Shortcut: `ace logout`.

### `ace account machine-code set [CODE|-]`

Set the code account devices enter once.

- `CODE`: The code; asked without echo when omitted

### `ace account machine-code clear`

Clear the machine code.

### `ace device list`

Paired devices.

### `ace device pair [SCOPES] [flags]`

A single-use link and QR code to pair a device.

- `SCOPES`: Comma-separated scopes; the defaults when omitted

- `--label NAME`: A name for the device
- `--ttl DURATION`: How long the link works: 5m, 1h, 24h or 7d
- `--device-ttl DURATION`: How long the device keeps access: 1d, 7d or 30d

### `ace device revoke DEVICE`

End a device's access.

- `DEVICE`: The device id

### `ace remote list`

Remote profiles, and which one is in use.

### `ace remote add [NAME] [ORIGIN] [flags]`

Add a remote machine, from a pairing link or by hand.

- `NAME`: A name for the profile
- `ORIGIN`: Its https origin, when adding by hand

- `--link URL`: A pairing link from ace device pair; - reads stdin
- `--fingerprint PIN`: Its public-key SHA-256, by hand
- `--device ID`: This device's id there, by hand
- `--token-file PATH`: A file holding the device token, by hand
- `--name NAME`: What the other machine calls this one

### `ace remote use NAME`

Send every later command to this remote (local for this machine).

- `NAME`: The profile

### `ace remote remove NAME`

Forget a remote profile.

- `NAME`: The profile

### `ace mcp list`

Outside MCP clients' access.

### `ace mcp add [flags]`

Let an outside MCP client use ace, and print its setup.

- `--scope SCOPE`: read or operate
- `--allow SCOPE,…`: Exactly these scopes
- `--ttl DURATION`: 30m, 12h, 30d or never
- `--project PROJECT,…`: Only these projects
- `--name NAME`: A name for the client

### `ace mcp revoke GRANT`

End an outside client's access.

- `GRANT`: The grant id

## Spade and the market

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

### `ace spade chat [BOT] [TEXT|-]`

Talk with a bot (Spade's main bot by default).

With TEXT it sends one message and prints the reply. Without it, on a terminal, it is a conversation: type a line, read the answer, Ctrl-C to leave.

- `BOT`: A bot's id or name; Spade's main bot when omitted
- `TEXT`: One message to send; - reads it from stdin

    ace spade chat
    # A conversation with Spade

    ace spade chat writer "Draft the release notes"
    # One message

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

### `ace market check [PATH] [flags]`

The market's checks on a folder, before publishing.

- `PATH`: The folder; this one when omitted

- `--type TYPE`: suit, spade-skill, spade-plugin or spade-bot
- `--name NAME`: The entry's name, when the folder doesn't say

## Agent tools

### `ace browser screenshot THREAD [flags]`

A screenshot of a thread's browser, saved to a file.

- `THREAD`: The thread whose browser

- `--url URL`: Open this page first
- `--output PATH`: Where to write the file
- `--duration DURATION`: How long to record, e.g. 5s

### `ace browser record THREAD [flags]`

An MP4 of a thread's browser, saved to a file.

- `THREAD`: The thread whose browser

- `--url URL`: Open this page first
- `--output PATH`: Where to write the file
- `--duration DURATION`: How long to record, e.g. 5s

### `ace sim list [flags]`

Simulators and emulators on this machine.

- `--thread THREAD`: The thread; defaults to ACE_THREAD_ID in an agent's shell

### `ace sim start SIM [flags]`

Take a simulator for the thread, boot it and show it live.

- `SIM`: The simulator or emulator

- `--thread THREAD`: The thread; defaults to ACE_THREAD_ID in an agent's shell
- `--no-boot`: Don't boot it

### `ace sim stop SIM [flags]`

Release a simulator when you finish.

- `SIM`: The simulator or emulator

- `--thread THREAD`: The thread; defaults to ACE_THREAD_ID in an agent's shell

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

### `ace sim act SIM ACTION… [flags]`

Tap, type, swipe, press keys or open apps (ace help sim act).

- `SIM`: The simulator or emulator
- `ACTION`: What to do, then its arguments

- `--thread THREAD`: The thread; defaults to ACE_THREAD_ID in an agent's shell
- `--value VALUE`: The value for setValue
- `--duration MS`: How long to press or swipe

### `ace sim screenshot SIM [flags]`

A JPEG of the screen.

- `SIM`: The simulator or emulator

- `--thread THREAD`: The thread; defaults to ACE_THREAD_ID in an agent's shell
- `--output PATH`: Where to write the file

### `ace sim logs SIM [flags]`

The device's recent log.

- `SIM`: The simulator or emulator

- `--thread THREAD`: The thread; defaults to ACE_THREAD_ID in an agent's shell
- `--limit N`: At most N results

### `ace cloud codex exec [PROMPT|-] [flags]`

Start a Codex Cloud task.

- `PROMPT`: What to do; - reads stdin

- `--env ENV_ID`: The Codex Cloud environment
- `--attempts N`: Attempts, 1 to 4
- `--branch BRANCH`: The branch to start from
- `--limit N`: At most N results
- `--cursor CURSOR`: The page after this cursor
- `--attempt N`: Which attempt
- `--idempotency-key KEY`: Run this mutation at most once; retry with the same key

### `ace cloud codex list [flags]`

Codex Cloud tasks.

- `--env ENV_ID`: The Codex Cloud environment
- `--attempts N`: Attempts, 1 to 4
- `--branch BRANCH`: The branch to start from
- `--limit N`: At most N results
- `--cursor CURSOR`: The page after this cursor
- `--attempt N`: Which attempt
- `--idempotency-key KEY`: Run this mutation at most once; retry with the same key

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
| `ace market appeal` | `ace market maintainer appeal` | 0.0.24 |
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
  - Publishing to the market is yours to do; withdrawing, transferring, deleting and
    installing are the person's, and become a request in your thread (ace help publishing).
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
  ace market check ./my-suit --type suit     the market's checks, locally
  ace market publish suit ./my-suit --draft  upload a draft and read its scan
  ace market draft publish DRAFT             publish it
  ace market status                          your entries and where each version is

Publishing needs this machine signed in to your ace account (ace login). Withdrawing,
transferring and handle changes ask you to sign in again first.
```

### The market's maintainer tools

```
Maintainer tools: ace market maintainer COMMAND. They need ACE_MARKET_SIGNER_TOKEN and a
signing key, and talk to market.acehq.dev directly, never through the daemon.

  keygen sign review feature revoke reports collection publisher block block-file
  block-pattern appeals appeal verify unverify official

ace help market maintainer COMMAND for one.
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
