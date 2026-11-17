# ace CLI audit

Date: 2026-11-17. Scope: every command `ace` accepts on `main` at 3abdafcc57, read from
`apps/daemon/src/cli.ts`, `apps/daemon/src/cli/*.ts`, the commands the CLI hands to other packages
(`@ace/accounts`, `@ace/service`, `diagnostics-cli.ts`, `tools/release/src/runtime.ts`), the help
text in `cli/main.ts`, [docs/daemon/cli.md](../daemon/cli.md), [ADR 0072](../adr/0072-headless-cli.md)
and [ADR 0092](../adr/0092-triage-and-doctor-repairs.md).

The owner's verdict was that the CLI "is too confusing and feels incomplete". The audit agrees.
The plumbing underneath is careful: idempotency keys, outbox replay, whole-tree waits that never
report done early, triage that works with ace broken. The surface on top grew command by command
with no shared grammar, no per-command help, and a human mode that mostly prints JSON.

The redesign that answers this audit is [docs/adr/0176-one-cli-grammar-interactive-home-and-market.md](../adr/0176-one-cli-grammar-interactive-home-and-market.md).

## 1. How a command runs today

- `cli.ts` takes the first word. `triage` and `doctor` go to `cli/rescue.ts`, which loads only
  what they need and never connects to the daemon (ADR 0092). Everything else goes to
  `cli/main.ts`.
- `main.ts` is one `if` chain over the first word. Commands that need the daemon open one
  authenticated WebSocket through `@ace/client` (`connectCli`); a few call the daemon's HTTP
  routes directly with the host token (`status`, `token`, `pair`, `devices`, `stop`, `login`,
  `logout`, `machine-code`); some never touch the daemon (`remote`, `logs`, `cloud`, `market`,
  `marketplace`, `config` and `spade`/`features` with the daemon down).
- `args.ts` is a hand-written parser: words, `--name value`, `--name=value`, a fixed set of
  boolean switches, `--` to end flags, and only `-f` and `-v` as short flags. Each command calls
  `validateArgs(args, allowedFlags, minWords, maxWords)`.
- Output goes through `io.ts`: `print` writes a string as text and anything else as JSON
  (indented in human mode, one line with `--json`). `--jq EXPR` pipes that JSON through the
  installed `jq`.
- Failures throw `CliFailure(outcome, message, evidence)`. `failure.ts` sets the exit code from
  `@ace/service/exit-codes` and writes the message to stderr, or `{ok:false,status,error}` to
  stdout in JSON mode.

## 2. Every command

"Daemon" says how a command reaches ace: **WS** (the client socket), **HTTP** (the daemon's
local routes with the host token), **none** (files only) or **market** (`market.acehq.dev`
directly). "Human output" says what a person sees without `--json`.

### Work: threads, tasks, chat

| Command                                                                                                                   | What it does                                                                                                                                                                                                                                                                                                      | Daemon | Human output                      |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------- |
| `ace run [PROMPT\|-] [--provider P] [--project ID\|PATH] [--worktree] [--model M] [--stream jsonl] [--idempotency-key K]` | Registers the project if it gets a path, then creates a thread with the prompt. Defaults to Codex. `--stream jsonl` also waits for the whole tree.                                                                                                                                                                | WS     | Admission object as indented JSON |
| `ace threads list [--project ID]`                                                                                         | The current thread list window.                                                                                                                                                                                                                                                                                   | WS     | Indented JSON                     |
| `ace thread read ID`                                                                                                      | The thread's loaded transcript window, its items and its interactions.                                                                                                                                                                                                                                            | WS     | Indented JSON                     |
| `ace thread send ID [TEXT\|-]` / `steer ID [TEXT\|-]`                                                                     | Queues or steers a message.                                                                                                                                                                                                                                                                                       | WS     | Receipt as indented JSON          |
| `ace thread approve\|deny ID [--interaction I] [--option O]`                                                              | Answers one pending approval or plan review. Questions and elicitations are refused ("requires a question or elicitation answer").                                                                                                                                                                                | WS     | Receipt as indented JSON          |
| `ace thread cancel\|interrupt ID`                                                                                         | The same command twice: interrupts the thread's tree.                                                                                                                                                                                                                                                             | WS     | Receipt as indented JSON          |
| `ace thread wait ID… [--any\|--all] [--tree] [--stream jsonl]`                                                            | Waits for up to 16 threads to reach an outcome. Returns early with exit 2 when a person is needed.                                                                                                                                                                                                                | WS     | Outcome as indented JSON          |
| `ace task spawn [PROMPT\|-] --parent ID [--provider P] [--model M] [--role R]`                                            | Starts a delegated child of `--parent`. Defaults to Codex.                                                                                                                                                                                                                                                        | WS     | Receipt as indented JSON          |
| `ace task status\|cancel ID`                                                                                              | The child's status (exit code follows its state), or cancels it.                                                                                                                                                                                                                                                  | WS     | Indented JSON                     |
| `ace task wait ID… [--any\|--all]`                                                                                        | `thread wait` with `--tree` always on.                                                                                                                                                                                                                                                                            | WS     | Indented JSON                     |
| `ace chat [--project] [--provider] [--thread ID] [--model]`                                                               | A line-mode conversation: `you>` prompt, a one-line streaming preview, `/stop`, `/steer`, `/model`, `/resume`, `/approve`, `/deny`, `/quit`, `/help`, `y`/`n` for a single pending approval. Starts the local daemon if it isn't running. `--json` or `--stream jsonl` makes it a JSONL protocol on stdin/stdout. | WS     | Rendered text                     |
| `ace kill-all [--thread ID] [--provider P] [--project ID]`                                                                | Cancels running work, optionally filtered; without filters also stops supervised process groups.                                                                                                                                                                                                                  | WS     | Receipt as indented JSON          |

### Projects and opening the app

| Command                                                     | What it does                                                                                                                                          | Daemon | Human output                       |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------- |
| `ace add [PATH]`                                            | Alias of `ace project add`.                                                                                                                           | WS     | Receipt JSON                       |
| `ace project add [PATH]`                                    | Registers a folder as a project.                                                                                                                      | WS     | Receipt JSON                       |
| `ace project list [--after ID] [--limit 1-100]`             | One page of projects.                                                                                                                                 | WS     | Indented JSON                      |
| `ace project rename ID NAME` / `remove ID [--stop-threads]` | Renames or removes a project.                                                                                                                         | WS     | Receipt JSON                       |
| `ace project open ID [--web]` / `ace open [PATH] [--web]`   | Opens the project in the desktop app (`ace://open`), falling back to the web app. `ace open` registers PATH first. Starts the local daemon if needed. | WS     | `{accepted, project, target}` JSON |

### The daemon and this machine

| Command                                                                                                                                                  | What it does                                                                                                                                                                      | Daemon | Human output                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------- |
| `ace` (no words)                                                                                                                                         | **Starts the daemon in the foreground**, the same as `ace start`.                                                                                                                 | —      | Daemon URL and token path                                |
| `ace start`                                                                                                                                              | Runs the daemon in the foreground. Exit 6 when the port is taken, 7 when another daemon holds the lock, 65/66 for newer or incompatible data. The desktop app spawns `ace start`. | —      | Daemon URL and token path                                |
| `ace serve`                                                                                                                                              | `start` with a headless browser backend. `chat` and `open` spawn `ace serve --json` detached to auto-start.                                                                       | —      | Same                                                     |
| `ace stop`                                                                                                                                               | Asks the daemon to shut down and waits for its cleanup receipt.                                                                                                                   | HTTP   | `{stopped, receipt}` JSON                                |
| `ace status`                                                                                                                                             | `{running:false}`, or the daemon's health.                                                                                                                                        | HTTP   | Indented JSON                                            |
| `ace token`                                                                                                                                              | Prints the local host token.                                                                                                                                                      | none   | The token                                                |
| `ace service install [--linger]\|uninstall\|start\|stop\|status`                                                                                         | Registers the daemon as a login service (launchd, systemd, Task Scheduler).                                                                                                       | none   | JSON                                                     |
| `ace logs [-f\|--follow] [--limit 1-1000]`                                                                                                               | Tails `logs/ace.jsonl` with the system `tail`.                                                                                                                                    | none   | Indented JSON array; `-f` is JSONL even without `--json` |
| `ace version`, `ace --version`, `ace -v`                                                                                                                 | The CLI's version.                                                                                                                                                                | none   | The version                                              |
| `ace support-bundle PATH [--include-threads]`                                                                                                            | Writes a redacted support bundle. Not on the rescue path.                                                                                                                         | none   | `Support bundle: PATH`                                   |
| Release runtime (`tools/release/src/runtime.ts`): `ace update`, `ace supervise`, `ace migrate-check DIR`, `ace spade-follow`, `ace install-artifact DIR` | Handled before `cli.ts` in a packaged release. `supervise` is what the login service runs. Not in `ace --help`.                                                                   | —      | —                                                        |

### Access: devices, remotes, MCP clients, the ace account

| Command                                                                                                      | What it does                                                                                | Daemon      | Human output      |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ----------- | ----------------- |
| `ace pair [SCOPES] [--label] [--ttl 5m\|1h\|24h\|7d] [--device-ttl 1d\|7d\|30d]`                             | Makes a single-use pairing link and prints it with a QR code.                               | HTTP        | URL, lifetime, QR |
| `ace pair redeem [URL\|-] --profile NAME [--name]`                                                           | Redeems another machine's pairing link into a remote profile.                               | none        | JSON              |
| `ace devices list` / `revoke ID`                                                                             | Paired devices.                                                                             | HTTP        | Indented JSON     |
| `ace remote add NAME ORIGIN --fingerprint PIN --device ID --token-file PATH`                                 | Adds a remote profile by hand.                                                              | remote HTTP | JSON              |
| `ace remote list\|use NAME\|remove NAME`                                                                     | Lists, selects or removes remote profiles. `use` changes the target of every later command. | none        | JSON              |
| `--remote NAME` (any WS command)                                                                             | Targets one remote profile for one command. Not in the help.                                | —           | —                 |
| `ace mcp enroll --scope read\|operate \| --allow S,… --ttl 30m\|12h\|30d\|never [--project ID,…] [--name N]` | Grants an outside MCP client access (ADR 0122) and prints setup snippets.                   | WS          | Setup text        |
| `ace mcp list` / `revoke ID`                                                                                 | Lists or revokes grants.                                                                    | WS          | JSON / sentence   |
| `ace login [--origin URL]`                                                                                   | Signs this machine in to an ace account: prints a URL, polls until signed in.               | HTTP        | Sentence          |
| `ace logout`                                                                                                 | Signs this machine out of its ace account.                                                  | HTTP        | Sentence          |
| `ace machine-code set [CODE\|-]` / `clear`                                                                   | The code account devices enter once (reads it without echo on a terminal).                  | HTTP        | Sentence          |

### Providers and accounts

| Command                                                                          | What it does                                                                                      | Daemon | Human output                      |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------ | --------------------------------- |
| `ace providers status`                                                           | Installed provider CLIs and their state.                                                          | WS     | Indented JSON                     |
| `ace capabilities`                                                               | Providers, the model list, each provider's permission capabilities and ace's tools.               | WS     | A very long indented JSON         |
| `ace login codex\|claude [--instance I] [--stream jsonl]`                        | Drives a provider CLI's own login. Only Codex and Claude.                                         | WS     | URL and code on stderr, then JSON |
| `ace accounts add PROVIDER ID HOME LABEL [--console]\|list\|status ID\|discover` | The provider-account registry (`@ace/accounts`). Writes `accounts.sqlite` directly.               | none   | Its own text                      |
| `ace cloud codex exec\|list\|status\|diff\|apply …`                              | Runs the installed Codex CLI's `codex cloud …` with an idempotency receipt in `cli-cloud.sqlite`. | none   | JSON                              |

### Tools agents call from a shell

| Command                                                                        | What it does                                                                                              | Daemon | Human output |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------ | ------------ |
| `ace browser shot\|record THREAD [--url] [--output PATH] [--duration 5s]`      | Screenshot or MP4 of the thread's browser, downloaded to a file.                                          | WS     | JSON         |
| `ace sim list\|start\|stop\|ui\|act\|screenshot\|logs … --thread ID [--human]` | The `sim_*` tools from a shell (its own help: `ace sim --help`). **JSON by default**, `--human` for text. | WS     | JSON         |
| `ace automation list` / `run ID [--variables JSON]`                            | Lists automations or runs one.                                                                            | WS     | JSON         |

### Storage and settings

| Command                                                                                                                        | What it does                                                                                                             | Daemon     | Human output                 |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ---------- | ---------------------------- |
| `ace storage [usage]`                                                                                                          | What ace's data uses on disk.                                                                                            | WS         | Indented JSON                |
| `ace storage plan [--kinds …\|--logs …] [--older-than 30d] [--retention JSON] [--force-items JSON]`                            | A cleanup plan to review.                                                                                                | WS         | Plan summary + apply command |
| `ace storage apply PLAN --revision R` / `status PLAN`                                                                          | Applies or reads a plan.                                                                                                 | WS         | Receipt                      |
| `ace clean [--threads] [--worktrees] [--artifacts] [--logs] [--attachments] [--caches] [--older-than 30d] [--dry-run] [--yes]` | Plans, shows the plan, asks `[y/N]`, applies. Refuses without a terminal unless `--yes`.                                 | WS         | Plan and receipt sentences   |
| `ace clean apply\|status PLAN`                                                                                                 | The same as `storage apply\|status`.                                                                                     | WS         | Receipt                      |
| `ace clean --compact [--abandon ID]`                                                                                           | Database compaction.                                                                                                     | WS         | Indented JSON                |
| `ace config get [NAME]` / `set NAME VALUE`                                                                                     | Three settings: `retention-days`, `log-cap`, `preparation-timeout`. Works without a daemon by writing the settings file. | WS or none | Sentences                    |
| `ace spade on\|off`                                                                                                            | Turns Spade on or off (`spade.enabled`); refused while the Beta switch is off.                                           | WS or none | Sentence                     |
| `ace features [on\|off spade\|marketplace]`                                                                                    | The Settings › Beta switches.                                                                                            | WS or none | Sentences                    |

### Repair

| Command                                                 | What it does                                                                                                                                       | Daemon                   | Human output              |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------- |
| `ace triage [--provider P] [--print]`                   | Writes `PLAYBOOK.md` and `FACTS.md` to a temp folder and starts an installed agent CLI there (ADR 0092). `--print` or no terminal prints the text. | never                    | Wizard (`@clack/prompts`) |
| `ace doctor [--fix] [--dry-run] [--all] [--provider P]` | Checks, then a repair checklist on a terminal, `--fix` for the recommended ones. Offers triage when findings remain.                               | only for database repair | Report text + checklist   |

### The marketplace

| Command                                                                                                                                                             | What it does                                                                                                                                                                          | Daemon | Human output                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------ |
| `ace marketplace check PATH --type TYPE [--name N]`                                                                                                                 | Runs the market's upload checks on a local folder.                                                                                                                                    | none   | Pass sentence or problem lines |
| `ace market keygen\|sign\|review\|feature\|revoke\|reports\|collection\|publisher\|block\|block-file\|block-pattern\|appeals\|appeal\|verify\|unverify\|official …` | **Maintainer tools only** (ADR 0168 §6–7, 0174 §10): sign pending versions, the review queue, blocks, verification, the official list. Need `ACE_MARKET_SIGNER_TOKEN` and a key file. | market | Sentences or JSON              |

There is no way for a person to search, install, update or remove anything from the market on the
CLI, and no way to publish. ADR 0174 says "a publisher can upload a version from the CLI";
that command doesn't exist. The daemon already has every operation a CLI needs
(`marketplace.request`: `search`, `read`, `prepare`, `readReview`, `install`, `installed`,
`prepareUpdate`, `remove`, `turnOn`, `discover`, `publisher`, `report` and `publish` with 30
actions, `packages/protocol/src/marketplace*.ts`).

## 3. Inconsistencies

### Naming and grammar

1. **Singular and plural nouns mixed at random.** `threads list` but `thread read`; `task`,
   `project`, `automation`, `remote` singular; `devices`, `accounts`, `providers`, `features`
   plural. A person has to remember which.
2. **One word, two meanings.**
   - `ace login` signs in to the ace account; `ace login codex` signs in a provider CLI. Which one
     you get depends on how many words follow.
   - `ace stop` stops the daemon; stopping a thread is `thread cancel`, `thread interrupt`,
     `kill-all` or `/stop` in chat.
   - `ace status` is the daemon; `task status` is a child thread; `providers status` is the
     provider list.
   - `ace market review` is the maintainer's review queue, while "review" in the market's own
     install flow is what a person reads before installing (`MarketReview`).
3. **Two words, one meaning.** `thread cancel` and `thread interrupt`; `ace add` and
   `ace project add`; `clean apply` and `storage apply`; `providers status` is a subset of
   `capabilities`.
4. **Two switches for one feature.** Spade needs `ace features on spade` _and_ `ace spade on`.
   The error for the second explains the first, but a person shouldn't need both.
5. **`market` vs `marketplace`.** `ace marketplace check` is for publishers; `ace market` is for
   maintainers. Nothing in the names says so.
6. **A task is a thread.** `task spawn` makes a child thread whose id is a thread id; `thread
   wait` and `task wait` differ only in `--tree`.
7. **Internal words in commands and messages:** `kill-all`, "interaction", "admission",
   "observation", "lease", "idempotency", "tree facts". The [design language](../design/design-language.md)
   §3 Voice rules out internal words.

### Flags

8. **Every flag is long-only.** No `-h`, `-q`, `-y`, `-p`; only `-f` (logs) and `-v` (version).
9. **The same idea spelled differently.** `--output PATH` (browser) and `--out FILE` (sim);
   `--stream jsonl` (run, wait, chat, login) and `-f/--follow` (logs); `--duration 5s` (browser,
   a duration) and `--duration MS` (sim, milliseconds); `--ttl` takes `5m|1h|24h|1d|7d|30d` on
   `pair` but any `Nm|Nh|Nd` up to four digits or `never` on `mcp enroll`.
10. **`--project` means three things:** an id or a path (`run`, `chat`), an id only (`--remote`
    runs), and a comma-separated list (`mcp enroll`).
11. **`--all` means two things:** every check (`doctor`), and wait for every id (`thread wait`).
    `--dry-run` previews a plan on `clean` and plans repairs without running them on `doctor`.
12. **JSON inside flags.** `--retention`, `--force-items` and `--variables` take raw JSON.
13. **Hidden flags.** `--remote NAME` works on every WS command and is in no help text;
    `--limit` on `logs`, `--after` on `project list`, `--role` on `task spawn`, `--instance` on
    provider login and `--name` on `pair redeem` aren't either. The help lists `[--thread ID|--provider|--project]`
    after `ace stop|kill-all`, but `ace stop` takes no flags.
14. **One default timeout for everything.** `--timeout` defaults to 240 s for every daemon
    command, including reads that answer in milliseconds and waits that are expected to run for
    an hour.
15. **The provider defaults to Codex** in `run`, `chat` and `task spawn`, whatever the person
    chose as their default in Settings.

### Output

16. **Human mode is mostly JSON.** `print` indents any object, so `threads list`, `thread read`,
    `project list`, `providers status`, `capabilities`, `status`, `devices list`, `mcp list`,
    `storage usage`, `remote list`, `automation list`, `task status`, `logs` and every receipt
    show a person raw JSON. Only `chat`, `clean`, `config`, `spade`, `features`, `login`,
    `doctor`, `triage`, `pair` and the maintainer tools render words.
17. **`sim` is the opposite:** JSON by default and `--human` for text.
18. **`--jq` isn't honoured everywhere.** `marketplace check` and every maintainer command test
    `args.flags.json` only, so `--jq` pipes human text into jq, which fails.
19. **`logs --follow` prints JSONL without `--json`**, and `accounts` writes login progress to
    stdout unless JSON is asked for.
20. **No quiet mode.** A script that wants only a thread id has to use `--jq .threadId`, which
    needs the jq binary installed.
21. **Success shapes vary:** an admission object (`run`), `{ok:true, idempotencyKey, data}`
    (`task`), a bare receipt (`thread send`), a bare array (`logs`), `{help: "…"}` for
    `--help --json`. Nothing in `@ace/protocol` describes CLI output except `CliTree` and
    `CliTaskStatus`.

### Exit codes and errors

22. **A typo and a refusal share exit 4.** Unknown commands, unknown flags, missing arguments,
    the daemon refusing a request and ace being busy all exit 4. An agent can't tell "I called
    it wrong" from "ace said no".
23. **Unexpected exceptions also exit 4.** Anything that isn't a `CliFailure` or `ClientError`
    is reported as `refused`, so a bug looks like a refusal.
24. **Raw schema errors.** A bad id (`ThreadId.parse`, `WorkspaceId.parse`,
    `MarketEntryType.parse`) prints Zod's issue list as JSON text as the error message.
25. **The daemon being down is a file error.** Every WS and HTTP command reads
    `ACE_HOME/daemon-endpoint` first; with no daemon it prints `ENOENT: no such file or
    directory, open '…/daemon-endpoint'` and exits 4. Only `chat` and `open` start it, and only
    `status` says `running: false`.
26. **Messages that don't say what to do.** "Invalid arguments. See ace --help." (which
    argument?), "Unknown command. See ace --help." (no suggestion), "Unknown thread command",
    "Select a pending interaction with --interaction" (which ones are pending?), "Tree facts
    unavailable".
27. **Market failures flatten to exit 1.** A 401 or 403 from the market is `failed`, not
    `refused` or `needs-human`; `marketplace check` finding problems exits 4 (`refused`) rather
    than 1.

Some messages are already good and set the bar: "Pass --yes to clean without a terminal, or
--dry-run to preview. Nothing was removed.", "Spade is turned off in Settings › Beta. Turn it on
there or with ace features on spade.", "Sign in to publish."

### Help and discoverability

28. **One wall of usage lines.** `ace --help` prints 50 lines of mixed notation for every
    command, twelve of them maintainer tools, with no descriptions and no examples.
29. **No per-command help.** `ace thread --help` prints the same wall. Only `ace sim --help`,
    `ace triage --help` and `ace doctor --help` have their own.
30. **`ace help` is an unknown command** and exits 4.
31. **No suggestions** for typos (`ace thraed list`), no completions, and no machine-readable
    list of commands for an agent to discover.
32. **Docs drift.** The help omits `preparation-timeout`, `--remote`, `ace cloud`'s flags,
    `ace project open`'s id form and the release-runtime commands. `docs/daemon/cli.md` covers
    work, process and MCP commands but none of storage, config, Spade, the market or remotes.

### Interactivity

33. **Bare `ace` starts a foreground daemon.** A person or agent typing `ace` to see what it does
    gets a daemon (or exit 7 if one is running).
34. **Three prompt systems.** `@clack/prompts` for triage and doctor, a `[y/N]` readline for
    `clean`, a raw `you>` readline for `chat`, and a muted readline for `machine-code`.
35. **Missing arguments aren't asked for.** `ace run` with no prompt on a terminal fails with
    "Supply a prompt or pipe it on stdin" instead of asking.
36. **Without a terminal, a missing prompt reads stdin.** `ace run` called by an agent whose
    stdin is an open pipe waits forever for input.
37. **No `--no-input`.** Each command decides on its own: triage checks stdin and stdout,
    `clean` only stdin, `chat` both.

## 4. Gaps: what the app can do and the CLI can't

| In the app                                                                                        | On the CLI                                                            |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| A list of what needs the person across every thread (Inbox)                                       | Only per-thread `thread read`; nothing lists pending requests         |
| Answering questions, elicitations and plan reviews with comments                                  | `approve`/`deny` only; questions refused                              |
| Settle, snooze, pin, rename, fork, archive a thread; switch its model at a turn boundary          | Only `/model` inside `chat`                                           |
| Search threads (ADR 0035)                                                                         | None                                                                  |
| The agent tree of a thread (Summary › Agents, ADR 0108)                                           | `CliTree` inside `wait` output only                                   |
| Models and their catalogue (ADR 0036)                                                             | Inside the huge `capabilities` JSON                                   |
| Other machines: list them, work on one (ADR 0101, 0111)                                           | Remote profiles only, and only by hand or pairing link                |
| The marketplace: Discover, search, install with review, updates, remove, sources, reports         | None                                                                  |
| Publishing: drafts, checks as sentences, publish, listing, versions, withdraw, profile (ADR 0174) | `marketplace check` only                                              |
| Spade: chat with a bot, bots, routines, questions waiting for later                               | `spade on\|off` only                                                  |
| Skills library (ADR 0103), Suits (ADR 0150)                                                       | None                                                                  |
| Automations: create, edit, remove (ADR 0015)                                                      | `list` and `run` only                                                 |
| Every setting in Settings (ADR 0032)                                                              | Three keys                                                            |
| Provider usage and limits                                                                         | None                                                                  |
| Approving an outside MCP client's sign-in (ADR 0122 `outside.request decide`)                     | None; `mcp enroll` makes a token grant only                           |
| App and daemon updates (ADR 0091, 0113)                                                           | `ace update` exists only in the release runtime and isn't in the help |
| Logging in to Cursor, OpenCode, Antigravity, Pi                                                   | `ace login` takes `codex` or `claude` only                            |

## 5. What agents running inside ace need from the CLI

Coding agents in ace threads already call `ace sim …` from their shells (the computer-use skill
tells them to) and could call any other command; Spade's bots reach ace through MCP.

1. **Machine output on every command,** with documented shapes. Today `--json` works on most
   commands, but shapes aren't in `@ace/protocol` and `--jq` is broken on some (item 18).
2. **Exit codes that separate the cases an agent acts on:** done, failed, needs a person,
   timed out, refused by ace, called wrong, unknown outcome (retry with the same key). Today
   "called wrong" is missing (item 22).
3. **Never wait for input it can't give.** Not on a terminal, nothing prompts and nothing reads
   stdin unless `-` was passed (item 36). An explicit `--no-input` for agents that run in a PTY
   (Codex can).
4. **Its own identity.** `ace sim` requires `--thread` on every call, and the agent has to look
   its own thread id up. ace starts the agent's CLI, so it can put that in the environment.
5. **Errors it can act on:** a stable code, the argument that was wrong, the next command to run,
   and the idempotency key to retry with.
6. **Discovery without reading prose:** the command tree, flags and output schemas as JSON.
7. **Bounded output.** `thread read` and `capabilities` can return very large JSON; agents need
   paging and field selection that don't depend on jq being installed.
8. **No surprise side effects.** Bare `ace` starting a daemon, or `ace open` launching the
   desktop app, are not what an agent probing the CLI expects.
9. **Rules that hold whoever runs the command.** An agent's shell runs `ace` with the person's
   local authority (it can read the host token). Publishing, withdrawing and other actions the
   market treats as sensitive (ADR 0174 §2) need rules in the daemon that an agent can't satisfy
   by passing `--yes`.

## 6. What to keep

- ADR 0072's contract: idempotency keys on every mutation, the persisted outbox, whole-tree waits
  that never report success while anything in the tree works or waits, uncertain outcomes kept
  distinct from failure, progress on stderr in machine mode, no ANSI in JSON.
- The exit code numbers that exist today (0–7, 65, 66). The desktop app reads 6, 7, 65 and 66.
- `ace start` and `ace serve` exactly as they are: the desktop app spawns `ace start`, and
  `chat`/`open` spawn `ace serve --json`.
- ADR 0092's rescue path: triage and doctor load before anything else and never need the daemon.
- Lazy loading: each command's module loads only when it runs, so `ace start` (the daemon's own
  process) carries none of the rest.
- The messages that already name the thing, the cause and the next step.
