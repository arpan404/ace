# 0176: One grammar for the ace CLI, an interactive home, and the market from the terminal

Status: accepted. Date: 2026-11-17. Decided by: the owner (2026-11-17: every recommendation of the
draft, recorded under "The owner's decisions" at the end). Amends [ADR 0072](0072-headless-cli.md) (the headless CLI): its
grammar, help, output and exit-code sections. Keeps [ADR 0092](0092-triage-and-doctor-repairs.md)
(triage and doctor) whole. Builds on [ADR 0168](0168-ace-marketplace.md) and
[ADR 0174](0174-market-publishers-discovery-and-scanning.md) (the market and its account-only
writes), [ADR 0171](0171-spade-decides-on-effects.md) (Spade's effect rules),
[ADR 0122](0122-outside-mcp-clients.md) (outside MCP clients) and
[ADR 0111](0111-account-machine-access.md) (the ace account on a machine).

The audit this answers is [docs/cli/audit.md](../cli/audit.md). The mockup is
`~/.ace/spade-mockups/ace-cli-v1/index.html`.

## Context

The owner: the ace CLI "is too confusing and feels incomplete", and it must be interactive. Agents
must also be able to publish to the market through it.

The audit found four kinds of problem:

- **No grammar.** Nouns are singular or plural at random, `login`, `stop`, `status` and `review`
  each mean two things, `market` and `marketplace` are different tools, and flags spell one idea
  three ways.
- **No human mode.** Most commands print indented JSON to a person, while `ace sim` prints JSON by
  default and text with `--human`.
- **No help.** One 50-line wall, no per-command help, `ace help` is an unknown command, no
  suggestions, no completions, and no machine-readable command list.
- **Missing pieces.** No interactive mode (bare `ace` starts a foreground daemon), no way to answer
  a question or list what needs the person, no market for people, no publishing, and about a
  dozen app features with no command.

The plumbing under the surface is sound and stays: idempotency keys and the persisted outbox,
whole-tree waits that never report success early, uncertain outcomes, triage that runs with ace
broken.

## Decision

### 1. One grammar: `ace <noun> <verb>`

Every command is `ace <noun> <verb> [ARGUMENTS] [FLAGS]`.

**Why noun first.** ace's surface is a set of things the person owns (threads, projects,
providers, devices, the market) with a small set of actions on each. Noun first groups the help,
the completions and the interactive menus the same way the app's places are grouped. Typing
`ace thread` and pressing Tab lists everything you can do to a thread. Verb first (`ace list
threads`) needs a much larger shared verb set and spreads one thing's actions across the help. It
is also what ADR 0072 chose, so most existing commands keep their shape.

Rules:

1. **Nouns are singular.** `ace thread`, `ace project`, `ace device`. The plural is accepted as an
   alias of the noun's `list` (`ace threads` is `ace thread list`). It's never shown in help.
2. **A bare noun runs its most common read:** `list` for collections (`ace thread`, `ace project`,
   `ace request`), `status` for single things (`ace daemon`, `ace account`, `ace spade`). On a
   terminal it opens that place in the interactive mode instead (§9).
3. **One verb set, one meaning each:**

   | Verb                            | Means                                                    | Never                                |
   | ------------------------------- | -------------------------------------------------------- | ------------------------------------ |
   | `list`                          | The collection, paged                                    | `ls`, `status`                       |
   | `show`                          | One thing in full                                        | `read`, `get`, `info`                |
   | `add` / `remove`                | Register or unregister a thing ace keeps                 | `enroll`, `delete` for registrations |
   | `start` / `stop`                | Begin or end work or a process                           | `cancel`, `interrupt`, `kill-all`    |
   | `on` / `off`                    | A switch                                                 | `enable`, `disable`                  |
   | `get` / `set` / `unset`         | A setting's value                                        |                                      |
   | `allow` / `deny` / `answer`     | Reply to a request                                       | `approve`                            |
   | `revoke`                        | End a credential (device, MCP grant), keeping its record |                                      |
   | `install` / `update` / `remove` | Market entries on this machine                           |                                      |
   | `publish` / `withdraw`          | Market entries for everyone                              |                                      |

   A noun may have its own verbs where none of these fits (`thread send`, `thread steer`,
   `thread wait`, `market check`), but a verb from the table always means what the table says.

4. **Arguments are positional when there's one obvious thing** (`ace thread show THREAD`), and
   flags otherwise. A flag never holds JSON: structured input is a file (`--variables @vars.json`)
   or repeated flags (`--keyword a --keyword b`).
5. **References read the same everywhere:** a thread or request by id or by an unambiguous prefix
   of at least 6 characters; a project by id, name or path; a market entry as
   `TYPE/NAME[@VERSION]` (`suit/dusk-harbor@1.2.0`); a publisher as `@handle`.
6. **A closed list of shortcuts** for what people type most. Each is exactly another command and
   is documented as such: `ace run` (`thread start`), `ace chat` (`thread attach`), `ace open`
   (`project open`), `ace login` / `ace logout` (`account login|logout`), `ace logs`
   (`daemon logs`), `ace status` (§7), and `ace start`, `ace serve` and `ace stop` (`daemon
start|serve|stop`). No other top-level words, except the rescue commands (`doctor`, `triage`)
   and `help`, `version` and `completion`.

### 2. Global flags

Every command takes these, parsed before the command's own:

| Flag                          | Short | Means                                                                                                 |
| ----------------------------- | ----- | ----------------------------------------------------------------------------------------------------- |
| `--help`                      | `-h`  | This command's help (§5)                                                                              |
| `--json`                      |       | Machine output (§3). Implies `--no-input`                                                             |
| `--jq EXPR`                   |       | `--json` filtered by the installed `jq` (unchanged from ADR 0072)                                     |
| `--quiet`                     | `-q`  | Only the result's identifiers, one per line, or nothing (§3)                                          |
| `--no-input`                  |       | Never prompt; a missing argument is a usage error (§9)                                                |
| `--yes`                       | `-y`  | Answer yes to a confirmation the person could have answered. Never answers a person-only action (§11) |
| `--remote NAME`               |       | Run against a remote profile (now documented)                                                         |
| `--timeout DURATION`          |       | Stop observing after this long (`30s`, `10m`, `0` for no limit)                                       |
| `--idempotency-key KEY`       |       | On every mutation, unchanged from ADR 0072                                                            |
| `--color auto\|always\|never` |       | `auto` follows the terminal, `NO_COLOR` and `FORCE_COLOR`                                             |
| `--version`                   | `-v`  | The CLI's version (`-V` also accepted)                                                                |

Commands that list take `--limit N` and `--after CURSOR`; their JSON carries `next`. Commands
that stream take `--follow` (`-f`): text on a terminal, JSON Lines with `--json`.
`--stream jsonl` stays as an alias of `--follow --json`.

Default timeouts follow the command: 30 seconds for reads and for a mutation's acknowledgement,
10 minutes for `wait` and `--follow`, none for `chat`, `attach` and the interactive home.

The default provider is the person's default from Settings, no longer always Codex.

### 3. Output: human, `--json`, `--quiet`

- **Human** is the default, whether or not stdout is a terminal, so a script's output doesn't
  change when it's piped. Each command has a renderer that prints words and aligned columns in
  the [design language](../design/design-language.md)'s voice: state, not chrome. Lists follow
  the app's order (pinned, needs you, running, finished unseen, the rest) with no section labels.
  A status shows as one glyph in its state's colour (`◆` an approval, `?` a question and `✦` a
  model to choose, all needs-you amber; `✕` failed, `◌` working with
  its running time, `◌3` waiting on three agents, `▣` background, `✓` finished unseen; nothing
  for idle, just the age). Colour is used only for state. Ids, paths, branches and commands are
  plain text that can be copied. Nothing prints indented JSON in human mode.
- **`--json`** prints exactly one JSON value per command on stdout. A success prints the
  command's data object, with no envelope, so `--jq .threadId` keeps working. A failure prints a
  `CliError` (§4) on stdout too, so a caller parses one stream; the exit code says which it was.
  Progress, prompts and notices go to stderr. JSON never contains ANSI.
- **`--quiet`** prints only what a script would pipe into the next command: `thread start`
  prints the thread id, `request list` the request ids, `market search` the entry refs, and
  actions print nothing. Errors still go to stderr with their exit code.
- **Streams** (`--follow`): JSON Lines, one typed record per line ending in a record of
  `type: "outcome"`, as ADR 0072 has it.

**The contract lives in `@ace/protocol`** (new `packages/protocol/src/cli-output.ts`, schema only):

- `CliOutcome`: the exit names of §4, and `CliErrorCode`: the stable error codes.
- `CliError`: `{ok: false, status: CliOutcome, code: CliErrorCode, error: string, hint?: string,
command?: string, argument?: string, retry?: {idempotencyKey: string}, admission?: unknown,
problems?: MarketProblem[]}`. `status`, `error` and `admission` keep ADR 0072's names, so
  existing callers keep parsing.
- `CliCommandTree`: every command, its id (`thread.list`), summary, arguments, flags, examples,
  output schema id and whether it mutates. `ace help --json` prints it.
- `cliOutputs`: command id to output schema, reusing the schemas the daemon already speaks
  (`Thread`, `StoragePlan`, `MarketEntrySummary`, `MarketPublishAnswer`, `CliTree`…).
  `ace help COMMAND --schema` prints that schema as JSON Schema (`z.toJSONSchema`), so an agent
  can read the shape without reading the source.

Adding a field is not a breaking change; renaming or removing one is, and goes through the
deprecation of §8.

### 4. Exit codes and errors

The numbers that exist keep their meaning (the desktop app reads 6, 7, 65 and 66). One is added:

| Code   | Name                | Means                                                                                                 |
| ------ | ------------------- | ----------------------------------------------------------------------------------------------------- |
| 0      | `ok`                | Done                                                                                                  |
| 1      | `failed`            | The work or check failed (a failed thread, a doctor failure, a blocked upload)                        |
| 2      | `needs-human`       | A person must act: a request is open, sign-in is needed, a person-only action is waiting              |
| 3      | `timeout`           | Stopped observing; the work may still run                                                             |
| 4      | `refused`           | ace understood and said no (not allowed, not found, busy, turned off)                                 |
| 5      | `uncertain`         | Don't know whether it happened; retry with the printed idempotency key                                |
| 6      | `address-in-use`    | `ace start`: the port is taken                                                                        |
| 7      | `lock-held`         | `ace start`: another daemon holds the home                                                            |
| **64** | **`usage`**         | **The command line was wrong: unknown command or flag, missing or bad argument** (sysexits' EX_USAGE) |
| 65     | `newer-data`        | A newer ace wrote this home                                                                           |
| 66     | `incompatible-data` | A store is in a format this build doesn't read                                                        |

Usage errors move from 4 to 64, so an agent can tell "I called it wrong" from "ace said no".
Unexpected exceptions stop being reported as refusals: they exit 1 with code `internal` and the
message "Something went wrong in ace. Run ace triage to report it."

**Error text** follows the design language's rule: name the thing and the cause in one line, then
the next step. No codes or internal words in the first line.

```
✕ No thread starting with t_9f2c on this machine.
  See your threads with ace thread list.
```

- A bad argument names the argument and what it takes ("THREAD must be a thread id, like
  t_9f2c41"); schema errors are turned into that sentence, never printed raw.
- The daemon being down is "ace isn't running. Start it with ace start, or open the app.", with
  code `daemon_down`, exit 4, never a file error.
- Unknown commands and flags suggest the nearest match by edit distance over the command tree
  (§5): `Unknown command thraed. Did you mean ace thread?`
- An uncertain outcome always prints the retry line: `Retry with --idempotency-key 7c1e… to make
sure it ran once.`

### 5. Help and discoverability

- `ace help` (and `ace -h`) prints a short overview, about 25 lines: the shortcuts, then the nouns
  grouped as Work (thread, request, project), This machine (daemon, service, status, logs,
  storage, config, doctor, triage), Providers and accounts (provider, model, account, device,
  remote, machine, mcp), Spade, the market and automations (spade, feature, market, automation),
  and Agent tools (browser, sim, cloud). Then one line: `ace help COMMAND for more. ace help topics for guides.`
- `ace help thread`, `ace thread --help` and `ace thread -h` print the noun's verbs, each with one
  line. `ace help thread send` prints one command: usage, a sentence, arguments, flags, two or three
  examples, special exit codes, and "See also".
- **Topics:** `ace help output`, `exit-codes`, `agents` (§10), `remote`, `publishing` (§12),
  `market-maintainer` (§12.6), `scripting`. Each is a page of text kept beside the command table.
- `ace help --json` prints the `CliCommandTree`; `ace help COMMAND --schema` its output schema.
- The command table is **data** (`cli/commands/table.ts`): names, aliases, arguments, flags,
  summaries, examples, the module that runs each command and whether it is rescue-safe. The
  parser, help, suggestions, completions, `--json` help, the interactive menus and the docs page
  `docs/daemon/cli.md` (generated) all read it. One source means help can't drift from behaviour.
  A test fails when a command module accepts a flag the table doesn't list, or the other way
  round.

### 6. Completions

`ace completion bash|zsh|fish|powershell` prints a script that calls the hidden
`ace __complete WORDS…`. That reads the command table for nouns, verbs and flags, and for
references (thread ids, projects, market entries, setting keys, remote names) asks the running
daemon with a 300 ms budget. With no daemon, or over the budget, it completes only what the table
knows. Completion never starts the daemon, never prompts and never writes. `ace completion
install` writes the script to the shell's usual folder and says where; the interactive home's
Settings offers it once.

### 7. The command tree

```
ace                                  the interactive home on a terminal (§9); the overview otherwise
ace help [COMMAND…|TOPIC] [--json] [--schema]
ace version
ace completion bash|zsh|fish|powershell|install
ace status                           this machine: daemon, ace account, what needs you, what runs

Work
ace thread list [--project P] [--needs-you] [--running] [--settled] [--limit N] [--after C]
ace thread show THREAD [--items N] [--before CURSOR]
ace thread start [PROMPT|-] [--project P] [--provider P] [--model M] [--worktree]
                 [--parent THREAD [--role R]] [--follow]          (shortcut: ace run)
ace thread attach [THREAD] [--project P] [--provider P] [--model M]  (shortcut: ace chat)
ace thread send THREAD [TEXT|-]
ace thread steer THREAD [TEXT|-]
ace thread stop THREAD | --all [--provider P] [--project P]
ace thread wait THREAD… [--any|--all] [--tree] [--follow]
ace thread status THREAD
ace thread tree THREAD
ace thread resume THREAD
ace thread rename THREAD NAME
ace thread settle|unsettle THREAD
ace thread snooze THREAD --until 1h|tomorrow|monday|needs-you|pr-changes
ace thread fork THREAD
ace thread model THREAD MODEL

ace request list [--thread THREAD]
ace request show REQUEST
ace request allow REQUEST [--always] [--option ID]
ace request deny REQUEST [--option ID]
ace request answer REQUEST [TEXT|-] [--choice ID]…

ace project list|show|add|rename|remove|open

This machine
ace daemon start|serve|stop|status|logs|token      (shortcuts: ace start|serve|stop|logs)
ace service install [--linger]|uninstall|start|stop|status
ace storage usage|plan|clean|apply|status|compact
ace config list|get|set|unset KEY [VALUE]
ace doctor [--fix] [--dry-run] [--all] [--provider P]
ace doctor bundle PATH [--include-threads]
ace triage [--provider P] [--print]

Providers and accounts
ace provider list|show PROVIDER|capabilities
ace provider login PROVIDER [--account A]
ace provider account list|add|show|discover
ace model list [--provider P]
ace account status|login [--origin URL]|logout
ace account machine-code set [CODE|-]|clear
ace machine list
ace device list|pair [SCOPES]|revoke DEVICE
ace remote list|add NAME (ORIGIN … | --link URL)|use NAME|remove NAME
ace mcp list|add|revoke GRANT

Spade, the market and automations
ace spade status|on|off
ace feature list|on|off FEATURE
ace automation list|show|run AUTOMATION [--variables @FILE]
ace market …                         (§11, §12)

Agent tools
ace browser screenshot|record THREAD [--url URL] [--output PATH] [--duration 5s]
ace sim list|start|stop|ui|act|screenshot|logs …
ace cloud codex exec|list|status|diff|apply …
```

`ace status` keeps today's JSON (the daemon's health, or `{running:false}`) and adds `account`,
`needsYou` and `working` fields (`working`, since `running` already says whether the daemon runs); in human mode it prints three short lines.

New commands in this tree that need daemon work first: `thread tree` and `status` use existing
facts (`CliTree`, the thread list); `request list|show|answer` need a cross-thread request list
and question answers on `cli.request` (the app already resolves questions through
`interaction.resolve`); `thread settle|snooze|rename|fork|model` and `model list` wrap commands
the app already sends; `machine list` reads ADR 0111's machine directory. `provider login` covers
every provider the daemon can sign in, not only Codex and Claude.

### 8. Old commands to new, and how they retire

Every old spelling keeps working for **two minor releases** after the new one ships. On a
terminal each prints one line to stderr ("ace threads list is now ace thread list."), and nothing
in `--json` or `--quiet` mode. Then the alias prints a usage error naming the new command (exit 64) for one more release, and is removed. The machine entry points never retire: `ace start`,
`ace serve`, `ace stop`, `ace status`, `ace version`, `ace service …`, and the release runtime's
`update`, `supervise`, `migrate-check`, `spade-follow` and `install-artifact`.

| Today                                                                                                                                                               | New                                                                                                         | Alias                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `ace` (no words, starts the daemon)                                                                                                                                 | Terminal: the interactive home. Otherwise the overview, exit 0. Starting the daemon is `ace start`          | none (decision 2)                                                                                                           |
| `ace start`, `ace serve`, `ace stop`                                                                                                                                | `ace daemon start\|serve\|stop`                                                                             | permanent                                                                                                                   |
| `ace status`                                                                                                                                                        | `ace status` (additive fields); raw health also at `ace daemon status`                                      | permanent                                                                                                                   |
| `ace token`                                                                                                                                                         | `ace daemon token`                                                                                          | yes                                                                                                                         |
| `ace logs [-f]`                                                                                                                                                     | `ace logs [--follow]` = `ace daemon logs`                                                                   | permanent shortcut                                                                                                          |
| `ace version`, `--version`, `-v`                                                                                                                                    | unchanged                                                                                                   | —                                                                                                                           |
| `ace run …`                                                                                                                                                         | `ace thread start …`                                                                                        | permanent shortcut                                                                                                          |
| `ace chat …`                                                                                                                                                        | `ace thread attach …`                                                                                       | permanent shortcut                                                                                                          |
| `ace threads list`                                                                                                                                                  | `ace thread list`                                                                                           | yes (`ace threads` stays as the plural alias)                                                                               |
| `ace thread read ID`                                                                                                                                                | `ace thread show ID`                                                                                        | yes                                                                                                                         |
| `ace thread send\|steer\|wait`                                                                                                                                      | unchanged                                                                                                   | —                                                                                                                           |
| `ace thread approve\|deny ID [--interaction I] [--option O]`                                                                                                        | `ace request allow\|deny REQUEST [--option O]` (or `--thread ID` when one is open)                          | yes                                                                                                                         |
| `ace thread cancel\|interrupt ID`                                                                                                                                   | `ace thread stop ID`                                                                                        | yes                                                                                                                         |
| `ace task spawn PROMPT --parent ID`                                                                                                                                 | `ace thread start PROMPT --parent ID`                                                                       | yes                                                                                                                         |
| `ace task status ID`                                                                                                                                                | `ace thread status ID`                                                                                      | yes                                                                                                                         |
| `ace task wait ID…`                                                                                                                                                 | `ace thread wait ID… --tree`                                                                                | yes                                                                                                                         |
| `ace task cancel ID`                                                                                                                                                | `ace thread stop ID`                                                                                        | yes                                                                                                                         |
| `ace kill-all [--thread\|--provider\|--project]`                                                                                                                    | `ace thread stop --all [--provider\|--project]`, `ace thread stop ID`                                       | yes                                                                                                                         |
| `ace add [PATH]`                                                                                                                                                    | `ace project add [PATH]`                                                                                    | yes                                                                                                                         |
| `ace project add\|list\|rename\|remove\|open`                                                                                                                       | unchanged, plus `show`                                                                                      | —                                                                                                                           |
| `ace open [PATH] [--web]`                                                                                                                                           | unchanged (= `ace project open`)                                                                            | permanent shortcut                                                                                                          |
| `ace pair [SCOPES] …`                                                                                                                                               | `ace device pair [SCOPES] …`                                                                                | yes                                                                                                                         |
| `ace pair redeem URL --profile NAME`                                                                                                                                | `ace remote add NAME --link URL`                                                                            | yes                                                                                                                         |
| `ace devices list\|revoke ID`                                                                                                                                       | `ace device list\|revoke ID`                                                                                | yes                                                                                                                         |
| `ace remote add\|list\|use\|remove`                                                                                                                                 | unchanged                                                                                                   | —                                                                                                                           |
| `ace mcp enroll …`                                                                                                                                                  | `ace mcp add …`                                                                                             | yes                                                                                                                         |
| `ace mcp list\|revoke`                                                                                                                                              | unchanged                                                                                                   | —                                                                                                                           |
| `ace providers status`                                                                                                                                              | `ace provider list`                                                                                         | yes                                                                                                                         |
| `ace capabilities`                                                                                                                                                  | `ace provider capabilities`                                                                                 | yes                                                                                                                         |
| `ace login codex\|claude`                                                                                                                                           | `ace provider login codex\|claude`                                                                          | yes (a bare `ace login` stays the ace account)                                                                              |
| `ace login`, `ace logout`                                                                                                                                           | unchanged (= `ace account login\|logout`)                                                                   | permanent shortcuts                                                                                                         |
| `ace machine-code set\|clear`                                                                                                                                       | `ace account machine-code set\|clear`                                                                       | yes                                                                                                                         |
| `ace accounts add\|list\|status\|discover`                                                                                                                          | `ace provider account add\|list\|show\|discover`                                                            | yes                                                                                                                         |
| `ace service …`                                                                                                                                                     | unchanged                                                                                                   | permanent                                                                                                                   |
| `ace support-bundle PATH`                                                                                                                                           | `ace doctor bundle PATH` (now on the rescue path)                                                           | yes                                                                                                                         |
| `ace triage`, `ace doctor`                                                                                                                                          | unchanged                                                                                                   | —                                                                                                                           |
| `ace storage [usage]\|plan\|apply\|status`                                                                                                                          | unchanged (`ace storage` alone is `usage`)                                                                  | —                                                                                                                           |
| `ace clean [KINDS…] [--dry-run] [--yes]`                                                                                                                            | `ace storage clean [KINDS…] [--dry-run] [--yes]`                                                            | yes                                                                                                                         |
| `ace clean apply\|status PLAN`                                                                                                                                      | `ace storage apply\|status PLAN`                                                                            | yes                                                                                                                         |
| `ace clean --compact [--abandon ID]`                                                                                                                                | `ace storage compact [--abandon ID]`                                                                        | yes                                                                                                                         |
| `ace clean --force-items JSON`, `--retention JSON`                                                                                                                  | `--force-item ID` (repeated), `--retention @FILE`                                                           | yes                                                                                                                         |
| `ace config get\|set NAME` (three short names)                                                                                                                      | `ace config list\|get\|set\|unset KEY` over every global setting; the three short names stay as key aliases | names permanent                                                                                                             |
| `ace spade on\|off`                                                                                                                                                 | unchanged, plus `status`. `on` also turns the Beta switch on, after one confirmation on a terminal          | —                                                                                                                           |
| `ace features [on\|off X]`                                                                                                                                          | `ace feature list\|on\|off X`                                                                               | yes (`ace features` stays as the plural alias)                                                                              |
| `ace automation list\|run ID [--variables JSON]`                                                                                                                    | `ace automation list\|show\|run ID [--variables @FILE]`                                                     | JSON form accepted during the window                                                                                        |
| `ace browser shot`                                                                                                                                                  | `ace browser screenshot`                                                                                    | yes                                                                                                                         |
| `ace browser record`                                                                                                                                                | unchanged                                                                                                   | —                                                                                                                           |
| `ace sim … --thread ID`                                                                                                                                             | unchanged; `--thread` defaults to `ACE_THREAD_ID` (§10); human text by default, `--json` for JSON           | `--human` accepted as a no-op                                                                                               |
| `ace sim screenshot --out FILE`                                                                                                                                     | `--output FILE`                                                                                             | `--out` accepted                                                                                                            |
| `ace cloud codex …`                                                                                                                                                 | unchanged                                                                                                   | —                                                                                                                           |
| `ace marketplace check PATH --type T`                                                                                                                               | `ace market check PATH [--type T]`                                                                          | yes                                                                                                                         |
| `ace market keygen\|sign\|review\|feature\|revoke\|reports\|collection\|publisher\|block\|block-file\|block-pattern\|appeals\|appeal\|verify\|unverify\|official …` | `ace market maintainer <same verb> …`                                                                       | yes. `ace market appeal` is routed by its flags during the window: `--answer` is the maintainer's, `--note` the publisher's |

### 9. Interactive mode

**When.** `ace` with no words opens the interactive home when stdin and stdout are both
terminals, `--no-input` isn't given, `ACE_NO_INPUT` isn't set and `ACE_THREAD_ID` isn't set (an
agent's shell, §10). A bare noun (`ace market`, `ace request`) on a terminal opens that place.
Otherwise bare `ace` prints the overview.

**It never takes over the screen.** The home and the views draw in place below the prompt, in
the terminal's own scrollback, like a picker. On quit they leave one line saying where you were.
No alternate screen, no mouse, no colour beyond state. A terminal narrower than 60 columns gets the
same views with the meta columns dropped.

**The home** is one flat list, in the order and with the status rules of the app's Inbox
(`@ace/ui-core`'s `rowAttention` and `row-status-display`, the same code the app uses, so the
terminal can never call a thread done while its tree works). Each row: status glyph and running
time, project, title, branch, provider. Under the list, one line of keys:

```
n new thread · r requests 3 · p projects · s Spade · m market · , settings · d doctor · ? help · q quit
```

- `↑↓` or `j k` move, `↵` attaches to the thread, `→` opens its agent tree under the row (ADR 0108's
  tree: each agent, what it does, its time), `/` filters by words, `x` stops the selected thread
  after a confirmation, `z` snoozes it, `e` settles it.
- **New thread** (`n`): the project (the current folder first, then recent ones), then provider and
  model (the person's defaults preselected), then the prompt. Enter sends; Alt+Enter or a trailing
  `\` adds a line; Ctrl-G opens `$EDITOR`. Then it attaches.
- **Requests** (`r`): every open approval, question and plan review across threads, one at a time
  ("1 of 3"), each as the app's request strip: the provider and one sentence, one line of detail
  (a command in mono, cut in the middle), and its answers as keys spaced apart: `y Allow once`,
  `n Deny`, `a Always allow`, `↵ details`. Questions show their choices as numbers, plus "Type an
  answer". Plans open in a pager, then `y Approve` / `n Ask for changes`.
- **Spade** (`s`): the bots with their state, and what each asked and is waiting on. Answering a
  Spade question works here; a full conversation with a bot opens in the app until `ace spade
chat` lands (Phase 4).
- **Market** (`m`): §11's search and install, as a list you type into.
- **Settings** (`,`): the global settings as a list of key and value; `↵` edits one with its own
  hint and validation (the same `configKeys`-style table, widened to every setting), plus Beta
  switches, sign-in state and completions.
- **Doctor** (`d`): runs `ace doctor`'s own checklist in place (the rescue module, §13).

**Attach** (`ace chat`, `ace thread attach`, `↵` on a row) replaces today's one-line preview with
the transcript as the app shows it: the person's messages, the agent's work folded under
"Worked for 3m 12s" (`↵` on it unfolds; with the composer empty, `↑` and `↓` walk those lines,
since what is in the scrollback can't be pointed at), the last answer in full, wrapped to the terminal, and
handoffs, stops and limits as one quiet line each. At the foot: the request strip when one is
open, then the live line ("Working for 1m 04s", or "Waiting for 2 subagents"), then the composer
(`›`). Typing sends to the queue as today; `/steer`, `/stop`, `/model`, `/resume` and `/quit` keep
their meaning; `Esc` goes back to the home. While a request is open and the composer is empty,
`y`, `n` and `a` answer it, which keeps today's `y`/`n`.

**Prompting for what's missing.** On a terminal, a command missing a required argument asks for
it instead of failing: `ace run` asks for the prompt (and the project when the folder isn't one),
`ace thread show` offers a picker of threads, `ace market install` a search, `ace request allow`
the open requests. Each question says which flag would have supplied it, so the person learns
the scripted form. **Nothing ever prompts** when stdin or stdout isn't a terminal, with
`--no-input`, `--json`, `--jq` or `--quiet`, or with `ACE_NO_INPUT=1` or `ACE_THREAD_ID` set.
There, a missing argument is a usage error (exit 64) naming the flag, and a missing prompt reads
stdin only when the argument is `-`, never by default.

**How it's built: `@clack/prompts` for questions, a small TUI of our own for the live views.**

- Questions (pickers, text, confirmations, checklists) use `@clack/prompts` 1.x. It is MIT
  (compatible with Apache-2.0), already a dependency and already what triage and doctor use. It
  is plain TypeScript with no native parts, and it works on Bun and on Node 26. The three other
  prompt mechanisms (clean's `[y/N]`, chat's `you>`, machine-code's muted readline) move onto it
  or onto the TUI below. The muted read stays `node:readline`, since clack's `password` echoes a
  mask.
- The home, attach, requests and market lists need a region that redraws as the daemon's state
  changes, which a prompt library doesn't do. These are written fresh in `cli/tui/` on
  `node:readline`'s keypress events and ANSI cursor movement, in the codebase's pure-core,
  thin-shell shape:
  - `keys.ts` decodes key sequences (pure); `layout.ts` measures width (East Asian wide, emoji,
    combining marks), wraps and cuts in the middle (pure); each view is a pure
    `view(state, width) → lines`; each model is a pure reducer over key presses and client events.
  - `terminal.ts` is the only I/O: raw mode, redrawing only the lines that changed, resize, and
    restoring the terminal (raw mode off, cursor shown) on exit, on Ctrl-C and on a crash.
  - Data comes from `@ace/client`'s stores (`threads()`, `thread(id)`), the same ones the web
    app uses, so reconnects, the outbox and status rules are the client's, not the CLI's.
- Not chosen: **Ink** (MIT, but React plus a reconciler and Yoga in the CLI, a large cold start,
  and a full-screen model we don't want); **OpenTUI** (a native Zig library to build and sign for
  every platform, and young); **blessed** and **terminal-kit** (unmaintained or heavy, full-screen);
  **everything fresh** (rewriting prompts clack already does well, which triage and doctor use).
  No code is copied from other CLIs; the TUI is written from this spec.
- Budget: the home's first lines (header and the cached thread list, then live rows) within 150
  ms of Enter on a warm Mac, measured in the delivery PR. The TUI and clack load only on a
  terminal; `ace start` and every `--json` command load neither.
  Built (2026-11-17, follow-up): the cached list is `ACE_HOME/cli-home-rows.json`, the first 40
  rows with what each row is and never its status; each draws "Syncing", the app's word for an
  unconfirmed row, until the live list replaces it. The first frame loads only the terminal,
  the view and that file: the CLI's config (and the schemas with it) loads on first use, and
  the home's path comes from `@ace/service/home-path`. `home-first-paint.perf.process.test.ts`
  holds the bound (best of five starts in a real pseudo-terminal: 95 ms on a busy Linux box).

**If the daemon isn't running,** the home says so in one line ("ace isn't running.") with three
keys: `s Start ace`, `d Doctor`, `t Triage`. Start runs the same detached start `chat` uses today.

### 10. Agents running inside ace

ace starts every agent session, so it gives the session's environment three variables:

- `ACE_THREAD_ID`: the thread the agent runs in. `ace sim`, `ace browser` and the market's
  agent path (§12.5) read it, so an agent no longer looks its own id up. An explicit `--thread`
  wins.
- `ACE_NO_INPUT=1`: never prompt, even in a PTY (Codex runs some commands in one).
- `ACE_HOME`: the home the session's daemon uses, so a CLI in an agent's shell talks to the right
  daemon.

These are hints for an honest caller, **not a security boundary**. The host token
(`ACE_HOME/daemon-token`) is the person's whole authority: any process that can read it acts as
the person. Spade's sandbox keeps its bots from it, but an unsandboxed coding agent with file
access can read it, unset these variables and call the daemon as `ace-cli` or as anything else.
So every check the CLI makes because of these variables guards honest agents only. What an agent
can't do is what enforces the person's part (§12.7): answer from the app or a paired device, or
complete a fresh ace sign-in in a browser. The provider's own permissions over the shell command
come first, as always.

In an agent's shell (`ACE_THREAD_ID` or `ACE_NO_INPUT` set) the CLI:

- connects to the local daemon as `ace-agent`, with its own outbox (`ACE_HOME/cli-agent`), so the
  daemon's agent rules apply to everything it sends: an agent's device never answers an approval,
  plan, elicitation or browser-help request, and never writes or resets settings;
- refuses what is the person's before reaching for a daemon, exit 2 with code `person_only`:
  `request allow|deny|answer` (and the old `thread approve|deny`), `config set|unset`,
  `feature on|off` and `spade on|off`, whatever `--yes` says, and market commands off the agents'
  allowlist when there is no thread to ask the person in (§12.5);
- on a remote profile, connects as the paired device, whose ticket admits no other id; the
  refusals above are then all that holds there. Each provider's shell must be checked to inherit these
  variables (Codex's `shell_environment_policy`, Claude Code's Bash tool, Cursor, OpenCode, Pi,
  Antigravity) before the CLI relies on them; where one doesn't, the agent passes `--thread` and
  `--no-input` as today.

What the build found (2026-11-17). The daemon hands each session its variables as
`SessionContext.agentEnv`, never as part of a shared process's environment or pool key:

- **Claude Code, Pi, ACP agents (Antigravity, Gemini):** one process per session, so the
  variables go into its environment and the shell tool inherits them. Claude Code's Bash and Pi's
  bash inherit the process environment. ace offers ACP agents no client terminal, so an ACP
  agent runs its shell commands itself; a fake agent's shell command sees the variables whether
  Antigravity starts from its installed command or a resolved launch plan. That
  `agy_acp_server`'s own shell tool keeps its process environment is still not checked on a real
  run.
- **Codex:** one app-server serves many threads, so its environment can't name a thread. Each
  thread's `thread/start|resume|fork` carries `shell_environment_policy.set.<NAME>` overrides, one
  dotted key per variable, so the person's own `set` entries stay.
- **Cursor:** the SDK host is started per session with them. Cursor SDK 1.0.35's local shell
  executors (bash, zsh, PowerShell and the plain one) all run commands with
  `{ ...process.env, ...sdkVariables, ...callEnv }`, so they keep the host's environment; a fake
  host's shell command sees the variables. Not yet seen on a real run.
- **OpenCode:** one server serves many sessions, and ace pre-starts a spare per account before
  the thread exists, so the server's environment can't name a thread. OpenCode's own
  `PUT /api/session/:id/environment` (in `@opencode/client` 2.0.22, the minimum; now a required
  route) replaces the server's process environment for one session's local shell commands; it
  is what OpenCode's CLI sends when it attaches to a shared server. ace sends what the server's
  process inherited, without OpenCode's server password, plus the thread's variables: for the
  root session at every open, before any input, and for each subagent session as ace admits it
  to the tree, since OpenCode doesn't pass a session's environment on to its subagents. OpenCode
  keeps it in the server's memory only (a location rebuild keeps it), so a resume on a restarted
  daemon, which starts a new server, sets it again. Spares start as before, so the open stays
  fast, and the body is never recorded in the thread's frames.

  A subagent's session is created and prompted before ace hears of it, so on its own a command
  could beat its setup, or run after a failed one, with the server's own environment. Two
  things close that (review follow-up, 2026-11-17):
  - **Ordered and fail-closed.** Every server ace owns loads ace's gate plugin
    (`adapter-opencode/src/agent-env-plugin`). Its `tool.execute.before` hook, which OpenCode
    2.x runs before every tool and lets a throw refuse, holds each session's tools until ace
    settles that session over the plugin's `ace.agent.environment` RPC: set (after the `PUT`
    lands), or failed. A failed or unconfirmed session (30 s) has every tool refused; ace also
    interrupts the subagent and records a warning saying why. The root's setup, gate included, is
    awaited at open, so a server whose gate never loads fails the open instead of running
    ungated. Verdicts live as long as the server process, across location rebuilds. Every
    session ace opens gets an explicit environment, with or without ace's variables.
  - **Nothing to fall back to.** `serve --stdio` takes its password only from the environment
    (no flag or file in 2.3.0) but deletes `OPENCODE_PASSWORD` and `OPENCODE_SERVER_PASSWORD`
    from its own environment once read, and ace starts the server without its own credentials
    (MCP bearer, daemon token, grant, signer and account keys), which no session environment
    carries either.

  An externally attached server's shells are left alone: ace didn't start it and installs no
  plugin in it. Rejected: `shell.create.before` (isn't told the session), permission rules
  (a subagent inherits its parent's, and saved "always allow" rules outrank them), a server
  per thread (no fast open), a wrapper shell (replaces the person's shell) and a later
  handshake (the same window and a second channel).

`ace help agents` is the page for them: use `--json` to parse and human text to read (it is
shorter and costs fewer tokens), check the exit code before the output, retry uncertain mutations
with the same `--idempotency-key`, and treat exit 2 as "hand back to the person". It says in so
many words that agents never answer requests. The built-in
skills that mention the CLI (`ace-computer-use`) are updated with the new spellings.

### 11. The market for people

Every market command goes through the daemon (`marketplace.request`), never to
`market.acehq.dev` directly, so this machine's sources, its index, its signature checks, its
device scan and its signed-in ace account are the ones used.

```
ace market                            Discover on a terminal; the overview of market commands otherwise
ace market search [QUERY] [--type T] [--category C] [--source S]
ace market show REF|@HANDLE           an entry: what it is, publisher, versions, review mark; or a publisher's page
ace market install REF [--version V] [--source S] [--yes]
ace market update [REF…|--all] [--yes]
ace market remove REF
ace market restore REF                turn a withdrawn or turned-off entry back on, from its pinned bytes
ace market installed [--updates]
ace market source list|add ADDRESS|remove SOURCE|on SOURCE|off SOURCE|refresh [SOURCE]
ace market report REF[@V] --reason R [--note TEXT]
```

Types are the market's own names: `suit`, `spade-skill`, `spade-plugin`, `spade-bot` (and
`ace-plugin` once installable).

**Install shows the review before anything changes.** `install` and `update` run `prepare`, then
print the review the app shows (ADR 0168): what it is, who published it, signed or not, ace's
review mark, what it can run and reach, the device scan's findings as sentences, what it needs
(bots, keys) and, for an update, what changed. On a terminal the person confirms ("Install
spade-plugin/linear-sync 0.4.1? It runs one MCP server and reaches api.linear.app.", `y Install`,
`n Cancel`, `↵ read the files`). Choices the app asks (which bots, start routines) are asked as
checklists. Without a terminal, `--yes` installs with the review's defaults (no routines started)
after printing the review to stderr; without `--yes` it exits 2 with the review in the error's
evidence. A review that's blocked ("This Suit fails ace's checks") exits 4 with its sentence. The
install sends the reviewed hash, so bytes that changed after the review aren't installed. From an
agent, install is person-only (§12.5); from the host-token CLI with no thread it needs an ace
sign-in from the last ten minutes, as the other person-only actions do (§12.7).

### 12. Publishing

#### 12.1 Commands

```
ace market check [PATH] [--type T] [--name N]       the market's checks on a folder; no account, no daemon
ace market publish TYPE PATH|ID [--name N] [--version V] [--changelog TEXT|-|@FILE]
                   [--draft] [--unlisted] [--wait] [--yes]
ace market draft list|show ID|update ID [--version] [--changelog] [--from PATH]|publish ID|delete ID
ace market status [REF]               your entries; each version's status (live, not-reviewed, waiting, withdrawn, blocked)
ace market versions REF               one entry's versions with status, changelog, deprecation
ace market describe REF [--title T] [--line L] [--description @FILE] [--category C]…
                        [--keyword K]… [--link URL]… [--picture N=FILE]
ace market changelog REF@V [TEXT|-|@FILE]
ace market latest REF VERSION|--newest
ace market deprecate REF@V --note TEXT | --clear
ace market visibility REF listed|unlisted
ace market archive|unarchive REF
ace market withdraw REF[@V] --reason TEXT           sensitive
ace market transfer REF --to @HANDLE                 sensitive
ace market transfer accept|decline TRANSFER          sensitive (the receiver)
ace market delete REF                                a draft-only or never-listed entry
ace market signals REF
ace market appeal REF@V --note TEXT [--replacement V]
ace market profile show|create|edit|handle HANDLE|avatar FILE|pins REF…
ace market verification show|apply|check
```

Each maps to one `publish` action of `MarketPublishAction` (`packages/protocol/src/marketplace-publish-ops.ts`):
`publish` is `draftCreate` then `draftPublish`, `status` is `me`, `versions` is `entry`, `describe`
is `listing` plus `preview`, and so on. The CLI adds no market logic. `check` runs
`@ace/marketplace/checks` locally, exactly as `ace marketplace check` does today.

#### 12.2 `ace market publish`, step by step

1. **Where the files come from.** A path is a folder on this machine (`{kind: "folder"}`); with
   `--remote` the CLI packs it into an archive (`{kind: "archive"}`, at most 6 MB). An id is one of
   the person's own Suits (`{kind: "suit"}`). The name and version come from the entry's own
   manifest, as `check` reads it; `--name` and `--version` override.
2. **Local checks first.** The same checks the market runs. Problems print as `path:line:
sentence` and exit 1 before anything is uploaded.
3. **The draft.** The daemon mints a market grant through this machine's ace account for this one
   request (ADR 0174 §2) and uploads. The market's scan comes back as sentences: notes and warnings
   are listed; a block exits 1 with code `blocked`, keeps the draft, and says how to appeal.
4. **Confirm.** On a terminal: "Publish suit/dusk-harbor 1.2.0 as @arpan? Listed, 14 files, 220
   KB. The scan found 1 note." with `y Publish`, `n Keep as draft`. Without a terminal `--yes` is
   needed, else exit 2 with the draft id. `--draft` stops here and prints the draft id.
5. **Publish.** "Published suit/dusk-harbor 1.2.0. It waits for ace's signer, usually a few
   minutes." When held: "It waits for a maintainer to look first, because it's your first
   version." `--wait` keeps watching until it is live or not-reviewed (exit 0), or blocked (exit 1).

#### 12.3 The account and fresh grants

- **Signed out** (`signed_out`): "Sign in to publish." Exit 2, hint `ace login`. On a terminal the
  CLI offers to sign in now (the `ace login` flow) and then carries on.
- **Sensitive actions** (install, withdraw, transfer and accepting one, changing the handle,
  deleting an entry, editing a verified profile, applying for or checking verification) need a
  sign-in within ten minutes (`reauth`, ADR 0174 §2). The market checks its share on the grant;
  the daemon checks install and the rest when they arrive over the host token (§12.7). On a terminal: "Sign in again to do this." and the sign-in link, then the action runs
  once the new session is recorded. Without a terminal: exit 2, code `reauth`. The CLI never holds
  a grant: the daemon mints one per request and drops it, as ADR 0174 requires.
- `suspended`, `quota`, `forbidden` and `conflict` exit 4 with the market's sentence.

#### 12.4 Errors a publisher reads

Scan findings, check problems and the market's refusals are shown as the sentences the market
and `@ace/marketplace` already write (`findingSentence`), never as codes. `--json` carries the
full `MarketScanReport` and `problems` in the `CliError`.

#### 12.5 Agents publishing

An agent publishes through **ace's MCP tools**, which know which thread is asking. The CLI is the
person's tool and the fallback for a shell.

- **An allowlist, not a denylist** (`apps/daemon/src/marketplace/agent-gate.ts`). An agent may
  run, under its provider's permissions: reads (sources, search, home, read, reading a review,
  installed, discover, a publisher's page, pictures, Spade's market skills), local checks
  (`draftCheck`, `privacyCheck`, what can be published), its drafts (create, read, update,
  delete), publishing a draft, and its status, versions, signals and verification status.
  **Everything else is the person's**, including any operation added later: installing,
  updating, removing or turning an entry back on, adding, removing or switching sources,
  reports, withdraw, transfer (offering and accepting), handle and profile changes, deleting an
  entry, verification, listings and changelogs, latest, deprecation, visibility, archive and
  appeals.
- **Two ace MCP tools.** `market_read` (`readOnlyHint: true`) and `market_publish` (not
  read-only, `openWorldHint: true`). Annotations stay honest, so a provider's own permission mode
  decides about each call, as for every ace tool.
- **Person-only actions become the person's request.** Asked for one, the tool answers that it's
  the person's, and ace opens a request in the asking thread's strip, in the person's words:
  "Codex asks you to withdraw suit/dusk-harbor 1.2.0: the colours fail contrast." with
  `Withdraw…` and `Dismiss`. `Withdraw…` runs it under the person's hand. Who can answer it is in
  §12.7; never an agent's device, MCP grant or Spade bot.
- **Ask me before agents publish** (decision 1) makes publishing a draft the person's too. It
  **fails closed**: settings not loaded yet, a read that fails, or a value that isn't a boolean
  count as on. Over the host token it changes only after a fresh sign-in (§12.7); a settings
  reset over the host token leaves it alone, and `ace config set` with ace down refuses to write
  it to the file.
- **Spade** uses the same two tools through its ace connection. Under ADR 0171 decision 3, ace
  declares their effects in the tool list it gives Spade: `market_read` is `read` and
  `market_publish` is `publish`, so Spade's reviewer looks at every publish (decision 4). The
  person-only actions reach the person the same way, which matches ADR 0171's rule that sends,
  payments and access changes are the person's. A sandboxed bot can't read the host token, so the
  MCP path is its only path.
- **From an agent's shell** with `ACE_THREAD_ID`, `ace market …` sends the thread id with its
  request and the daemon applies the same allowlist: allowed actions run (the provider asked
  about the shell command), and the rest become the same request and exit 2 with its id. With
  only `ACE_NO_INPUT` there is no thread to ask in, and the CLI refuses them itself, exit 2
  `person_only`. `--yes` changes neither.
- **The thread field is the caller's word.** `marketplace.request` names a thread when an agent
  asks, and the daemon can't verify that a host-token caller who names none is the person. So a
  request without a thread isn't trusted as the person's: over the host token, its person-only
  actions need a fresh sign-in (§12.7).
  How a coding agent publishes, in its own words:

```
$ ace market check ./suits/dusk-harbor --type suit --json        # local; fix any problems
$ ace market publish suit ./suits/dusk-harbor --draft --json     # a draft and its scan
{"kind":"draft","draft":{"id":"dr_4kq…","scan":{"level":"note",…}}}
$ ace market draft publish dr_4kq… --json --yes
{"kind":"published","type":"suit","name":"dusk-harbor","version":"1.2.0","held":false}
$ ace market withdraw suit/dusk-harbor@1.1.0 --reason "Contrast fails" --json
{"ok":false,"status":"needs-human","code":"person_only","error":"Withdrawing is yours to do. ace asked you in this thread.","request":"rq_7f…"}
```

#### 12.6 Maintainer tools, kept apart

The signer's tools move under `ace market maintainer` with their verbs unchanged (keygen, sign,
review, feature, revoke, reports, collection, publisher, block, block-file, block-pattern,
appeals, appeal, verify, unverify, official). They are the one part of the CLI that talks to
`market.acehq.dev` directly, with `ACE_MARKET_SIGNER_TOKEN` and a signing key file, and never
through the daemon or an ace account. `ace help` doesn't list them; `ace market --help` ends with
one line, "Maintainer tools: ace help market-maintainer", and every maintainer command's help and
first error say "Maintainer tool: needs ACE_MARKET_SIGNER_TOKEN and a signing key." They get the
same human, `--json` (now `--jq` too) and exit-code rules as everything else. They send
`ACE_MARKET_SIGNER_TOKEN` to `market.acehq.dev` only; a development market must be named on
purpose with `--dev-market URL` (https, or http on this machine), and the old `--url` naming any
other host is a usage error, so a mistyped or planted origin never receives the token.

#### 12.7 What enforces the person's part

The host token is full person power (§10), so the daemon draws the line where an agent can't
follow:

| Who asks                                              | Answers a request                                                                   | Person-only market action  | "Ask me before agents publish" |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------- | ------------------------------ |
| The app, a paired device                              | Yes                                                                                 | Yes                        | Yes                            |
| The host-token CLI, a person at a terminal            | Typed confirmation; a market request also needs a fresh sign-in                     | Fresh sign-in              | Fresh sign-in                  |
| The host-token CLI off a terminal                     | Never (exit 2, `confirm`)                                                           | Fresh sign-in              | Fresh sign-in                  |
| An agent's shell (`ACE_THREAD_ID` or `ACE_NO_INPUT`)  | Never (exit 2, `person_only`)                                                       | A request for the person   | Never                          |
| `ace-agent`, `ace-reviewer` (ace's own agent devices) | Never (`human_answer_required`), except a parent answering its own child's question | Only through the allowlist | Never                          |

- **Fresh sign-in** means this machine's ace account signed in within the last ten minutes (ADR
  0174 §2), read from a market grant the daemon takes for the check: the gap between its `iat`
  and its `authAt`, both on the account backend's clock, so this machine's clock can't make a
  stale sign-in look fresh. The sign-in happens in a browser, which an agent can't do for the
  person. Refusals are `reauth`, saying to use the app or a paired device, or `ace login` and try
  again within ten minutes.
- **Typed confirmation.** Answering from the CLI needs a person at a terminal (stdin and stdout
  both terminals, no `--json`, `--quiet` or `--no-input`) who types the verb (`allow`, `deny`,
  `answer`); Enter alone doesn't confirm. Off a terminal nothing is answered, `ace chat`'s piped
  `y` and `/approve` included. The interactive home's request strip answers with a deliberate key
  (`y`, `n`, `a`), never Enter, which opens the details.
- **What this doesn't stop.** A process that reads the host token can still drive a
  pseudo-terminal it starts, or act as the person for everything the table leaves to the host
  token. The typed confirmation and the agent checks raise the bar for honest agents and
  mistakes; the fresh sign-in and the app are the boundary. A request or setting that matters
  more than the host token goes behind them.

### 13. ADR 0092 still holds

- `cli.ts` keeps routing before the command table loads. The rescue-safe set grows to `triage`,
  `doctor` (with `doctor bundle`, which moves from `support-bundle` onto this path), `help`,
  `version` and `completion` without a daemon. They import only the command table (pure data with
  no imports), the parser and their own modules.
- Bare `ace` loads the interactive home lazily. If that import fails (a broken install), `cli.ts`
  catches it and prints the overview and "Something in ace is broken. Run ace doctor or ace
  triage." The home's Doctor and Triage keys call the rescue modules, never the daemon.
- The interactive home with no daemon offers Start, Doctor and Triage (§9), so the person who
  types `ace` when things are broken lands on the way out.
- Triage and doctor keep their current behaviour, flags and output; they only gain `-h` and the
  shared error text.

### 14. Where the code goes

```
apps/daemon/src/cli.ts                 entry: rescue routing, then main
apps/daemon/src/cli/commands/table.ts  the command table (data); aliases and deprecations
apps/daemon/src/cli/parse.ts           argv to {command, args, flags} against the table (pure)
apps/daemon/src/cli/suggest.ts         nearest command or flag (pure)
apps/daemon/src/cli/help/              overview, command and topic pages, --json tree (pure)
apps/daemon/src/cli/render/            human renderers per noun (pure: value → lines)
apps/daemon/src/cli/errors.ts          CliFailure → CliError and its sentence (pure)
apps/daemon/src/cli/tui/               keys, layout, terminal shell
apps/daemon/src/cli/interactive/       home, attach, requests, market, settings: models and views
apps/daemon/src/cli/<noun>.ts          one module per noun, as today, behind the table
packages/protocol/src/cli-output.ts    CliOutcome, CliErrorCode, CliError, CliCommandTree, cliOutputs
packages/mcp-server                    market_read, market_publish
```

`main.ts`'s `if` chain and the 50-line help string go; `args.ts`'s `switches` set becomes the
table's flag definitions. Every file stays under the 400-line aim.

### 15. Delivery

1. **The foundation.** The command table, parser, help, suggestions, errors and exit 64, the
   `@ace/protocol` contract, `ace help --json`, completions, human renderers for every existing
   command, and every alias of §8. Behaviour of each command unchanged otherwise.
2. **Interactive.** The TUI, the home, attach (replacing `chat`'s renderer), requests with question
   answers, prompting for missing arguments, the agent environment variables.
3. **The market.** §11 and §12, `market_read` and `market_publish`, the person-only request, and
   the maintainer move.
4. **The gaps.** Thread settle, snooze, rename, fork, model; `model list`; `machine list`; every
   setting in `config`; automations create and remove; skills and Suits; `ace spade chat`.

## Options considered

- **Verb first** (`ace list threads`, `ace start thread`). Reads like English for a few commands,
  but needs one large verb set that means different things on different nouns, and scatters a
  thing's actions across the help. Rejected, see §1.
- **Keep the grammar, just add help and an interactive mode.** Leaves `login`, `stop`, `status`
  and `review` meaning two things and every alias in place. The confusion the owner names is
  mostly the grammar.
- **A JSON envelope on success** (`{"ok":true,"data":…}`). Uniform, but breaks every `--jq`
  filter and agent prompt in use, and the exit code already says success. Rejected; failures keep
  their object.
- **JSON automatically when stdout isn't a terminal.** Agents would get JSON without asking, but
  piping a command into `less` would change what it prints, and models read short text more
  cheaply than JSON. Rejected; `--json` is explicit.
- **A full-screen TUI (Ink or OpenTUI).** Matches some agent CLIs, but takes the terminal over,
  loses scrollback, costs a heavy cold start (Ink) or native builds per platform (OpenTUI), and
  doesn't fit the design language's quiet. Rejected for the inline views of §9.
- **Agents publish only from the CLI.** Simple, but the daemon can't know which thread asks, and
  Spade's sandboxed bots can't reach the host token. Rejected for MCP-first.
- **The person approves every agent publish in ace.** Safest, but it adds ace's own gate to an
  ace tool, against the rule that ace tools follow the provider's permissions, and Spade already
  reviews publishes. Rejected as the default (decision 1); the "Ask me before agents publish" setting offers it.

## Consequences

- Scripts that parse `ace … --json` keep working: success shapes don't change and failures gain
  fields. Scripts that test for exit 4 on a typo see 64 instead.
- Old spellings keep working through the deprecation window, with a one-line notice on a
  terminal only.
- `ace` on a terminal no longer starts a daemon; anything that relied on bare `ace` to start one
  must call `ace start`. The desktop app and the services already do.
- `docs/daemon/cli.md` becomes generated from the command table plus hand-written topic pages, so
  it stays complete.
- The daemon gains a cross-thread request list, question answers on `cli.request`, the
  person-only market request, the two MCP tools and the agent environment variables. Each has its
  own tests.
- A crash inside the TUI must leave the terminal usable; the terminal shell restores it on every
  exit path, and a process test proves it.
- Answering a request now needs the app, a paired device, or a person typing at a terminal:
  scripts that piped `ace thread approve` or `y` into `ace chat` stop working, by design (exit 2,
  `confirm`). An agent's shell can't answer at all.
- The maintainer tools' `--url` gives way to `--dev-market`; `--url` naming anything but
  `market.acehq.dev` is a usage error.
- `ace request list` reads an in-memory set of the threads waiting on a person, kept by the event
  writer and filled on first use from the live-threads partial index, so it does no
  history-sized work (ADR 0170).

## Tests

Per AGENTS.md: behaviour through public surfaces, pure tables at the unit level, one process
test per wiring.

- **Parser and table** (unit): tables of argv to command and flags, aliases to their command,
  unknown words to exit 64 with the right suggestion, the deprecation notice on a terminal only,
  `--no-input` and `ACE_THREAD_ID` turning prompting off.
- **Help** (unit): every table entry renders a page with usage and an example; `help --json`
  parses as `CliCommandTree`; a command module that accepts a flag the table doesn't list fails.
- **Renderers** (unit): a thread list with a working subagent under a finished parent renders the
  parent as working, never finished; widths, wide characters and middle cuts.
- **Errors** (unit): each `CliFailure` and schema error becomes its sentence and `CliError`; the
  daemon being down reads "ace isn't running."
- **TUI models** (unit): key presses over a fake client's events give the expected screens; a
  request answered with `y` sends one `interaction.resolve` with the allow-once option.
- **Process tests:** `ace help` and `ace doctor` work with a module of the command table broken
  (the ADR 0092 guarantee); bare `ace` without a terminal prints the overview and starts nothing;
  the home in a real PTY against a temp daemon opens, attaches, answers an approval and restores
  the terminal after SIGINT; `ace market publish --draft` against a fake market and account
  reaches the draft, and `withdraw` from a shell with `ACE_THREAD_ID` set exits 2 with a request
  id; every alias of §8 reaches the same daemon operation as its new form.
- **The person's part** (`answer-gate`, `fresh-sign-in`, `agent-gate`, `person-gate`): an
  agent's shell can't allow, deny, answer or change settings; a host CLI off a terminal can't
  answer, and at a terminal answers only with the typed word; ace's agent devices can't answer a
  provider's approval or write settings through a real daemon; person-only market requests and
  thread-less installs over the host token are refused without a fresh sign-in and run with one;
  agent operations off the allowlist become the person's; the setting fails closed; request.list
  stays bounded with a large thread table.

## The owner's decisions

The owner took every recommendation on 2026-11-17, and asked for a CLI that covers what the app
does.

1. **Agents' publishes don't come to the person first.** Publishing follows the provider's
   permission mode, plus Spade's reviewer for bots. Withdraw, transfer (offering and accepting),
   handle changes, deleting an entry, verified-profile edits, verification and installing are
   person-only (§12.5); after the review below, agents run only an allowlist and everything else
   is person-only. A global setting, **"Ask me before agents publish"**
   (`market.askBeforeAgentPublish`), off by default, turns every agent publish into a request in the
   asking thread's strip that only a person's device answers.
2. **Bare `ace` without a terminal prints the overview and exits 0**, from this release. Nothing in
   ace calls bare `ace`; starting the daemon is `ace start`.
3. **Usage errors exit 64.**
4. **The interactive home is inline**, drawn below the prompt in the terminal's scrollback, never
   full-screen.
5. **`ace chat` stays** as the shortcut for `ace thread attach`.
6. **Deprecation:** an old spelling prints a notice for two minor releases after its replacement
   ships, then is a usage error naming the new command for one release, then is removed. While ace
   is versioned `0.0.N`, each release counts as a minor release. The new grammar ships in 0.0.24,
   so its old spellings print a notice through 0.0.26 (on a terminal only), are a usage error in
   0.0.27 and are gone from 0.0.28 (`apps/daemon/src/cli/deprecation.ts`). The machine entry points
   of §8 never retire.
7. **Maintainer tools live under the hidden `ace market maintainer …`** in the same binary.

## Review follow-up (2026-11-17)

A read-only review found that "agents never answer approvals" didn't hold through the new CLI,
and that the market gate trusted a field the caller chooses (`thread`). The owner's decisions:

1. In an agent's shell the CLI refuses answers, settings and person-only market verbs with
   `person_only`, and connects as `ace-agent` so the daemon's checks apply (§10).
2. Answering from the host-token CLI needs a person at a terminal who types the confirmation;
   off a terminal it is refused (§12.7).
3. Person-only market requests are answered from the app or a paired device, or from the CLI
   after a fresh ace sign-in (ADR 0174 §2). Install joins the fresh-sign-in list. The same holds
   for thread-less person-only market operations over the host token, and for changing "Ask me
   before agents publish" (§12.5, §12.7).
4. Agents' own approvals get the device check the market and ask paths have (§12.7).
5. The market gate is an allowlist; "Ask me before agents publish" fails closed (§12.5).
6. `request.list` reads no history-sized table (Consequences).
7. The signer token goes only to market.acehq.dev unless `--dev-market` names another (§12.6).

The ADR says plainly what each check is: the host token is full person power, so the CLI's agent
checks guard honest agents, and the app, paired devices and fresh sign-ins are the boundary.
