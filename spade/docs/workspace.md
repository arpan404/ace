# Workspaces and skills a bot writes

Date: 2026-11-12, the skill store 2026-11-14. As built for
[ADR 0130](../../docs/adr/0130-spade-skills-and-workspace.md) and points 1–7 of
[ADR 0151](../../docs/adr/0151-spade-skills-and-plugins.md), in `spade-server` (`workspace/`,
`learning/`, `skill_store/`, `api/workspace.rs`, `api/skills.rs`). Extends
[harness.md](harness.md) and [agents.md](agents.md).

## The workspace

Each bot has a folder, `<data folder>/workspace/<bot id>/`, created the first time a tool or the
app uses it and deleted with the bot. Paths given to the tools and the API are relative to it,
with `/`. A path is refused when it is absolute, starts with `~` or uses `..`.

Every file operation, for the tools and for the API, goes through the folder's opened directory
handle (`cap-std`): each component is resolved relative to it, and a symlink that leads out of it,
or a folder swapped for one mid-operation, is refused rather than followed. The folder itself is
opened without following a link in its place. A write goes to `.<name>.spade-<random>` beside the
target and is renamed over it (a link at the target is replaced, never written through); a file
with more than one hard link is refused. Kept outputs (`.spade/outputs`) are written the same
way.

Files are opened with `O_NONBLOCK` and read only when the opened handle is a regular file; a
folder, FIFO, socket or device is refused (`422` from the API), so a read, search, edit or download
never waits on one. Searches skip anything but regular files without opening it.

### Tools

| Tool               | Arguments                   | Risk  | What it does                                                                              |
| ------------------ | --------------------------- | ----- | ----------------------------------------------------------------------------------------- |
| `workspace_list`   | `path?`                     | read  | One folder: folders first (`name/`), files with their size, links marked; 500 entries max |
| `workspace_read`   | `path, offset?, limit?`     | read  | Numbered lines `offset..offset+limit` (default 1 and 400, at most 2,000) of a text file   |
| `workspace_search` | `text, path?, ignore_case?` | read  | `path:line: text` for lines containing `text`; links not followed, 200 matches max        |
| `workspace_write`  | `path, content`             | write | Writes the whole file (2 MiB max), creating folders                                       |
| `workspace_edit`   | `path, old, new`            | write | Replaces the one place `old` appears; refused when it appears 0 or several times          |
| `shell`            | `command, timeout_s?`       | write | Runs the command in the folder (see below)                                                |

Text files are read up to 4 MiB; anything not UTF-8 is reported as binary.

### The shell

On macOS and Linux the bot's commands now run in its persistent terminal, which the person can
watch and take over; see [computer.md](computer.md). What follows is the one-shot shell, which
Windows still uses, and the rules both share.

- `/bin/sh -c <command>` on macOS and Linux, `%SystemRoot%\System32\cmd.exe /D /S /C <command>`
  on Windows (`workspace/shell.rs`, the one platform branch).
- Contained: on macOS and Linux its own process group (`process_group(0)`), killed with
  `kill -KILL -<group>`; on Windows a job object with kill-on-close, which the command is assigned
  to as it starts (anything it starts in the moment before that is not held). Everything is
  killed when the deadline passes (default 60 s; the model may give any longer `timeout_s`) and
  again when the run ends however it ends (finished, timed out, or the call
  dropped by Stop or the harness), and the output readers are aborted with it.
- A command still running after the turn's 30 s foreground window keeps running as a background
  job: the call answers with its job id and the output arrives as a `<job_result>` (ADR 0158).
- Environment: cleared, then `LANG`, `TMPDIR`, `USER`, `LOGNAME` from Spade's own (POSIX) or
  `SystemRoot`, `SystemDrive`, `windir`, `TEMP`, `TMP` (Windows), plus `HOME` (and `USERPROFILE`)
  set to the workspace, `TERM=dumb`, `SHELL=/bin/sh` (POSIX) or
  `NoDefaultCurrentDirectoryInExePath=1` (Windows, so cmd.exe never looks in the workspace
  first). `PATH` is never Spade's own: `/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  or `System32`, the Windows folder, `Wbem` and `WindowsPowerShell\v1.0` under a `SystemRoot`
  that is a plain drive path (else `C:\Windows`). Nothing else of Spade's environment reaches it:
  not its token, endpoint keys or ace's grant.
- stdin is empty; stdout and stderr are each kept up to 4 MiB. What was read is kept even when a
  process that left the group holds a pipe open past the end (the readers wait 2 s, then the run
  says some output may be missing). The model reads `Exit code N.` (or how it was stopped),
  stdout, then `[stderr]` and stderr. A command that timed out or exited non-zero is an error
  result.

**Sandboxed commands.** Where Spade's OS sandbox holds files and network (macOS today), a
command runs in the bot's sandbox and isn't reviewed unless the classifier finds something that
could leave through an allowed path; see [security.md](security.md). What follows holds where
there is no sandbox.

**Asking.** Every shell call is a write and asks, even one that only reads; reading without
asking goes through the file tools. Answering with `always` allows that exact command (the same
string) for the bot from then on, and nothing else: `Tool::always_scope` gives the shell's scope
as the command, and the gate looks for an `approval_answered` with `always` whose
`approval_requested` had the same tool and scope in the conversation's events. A turn that read
untrusted content asks for every command, `always` or not; since shell output is untrusted, that
includes a second command in the same turn.

### Trust

Trust is an allowlist. A bot's trusted files are recorded in
`<data folder>/workspace/.trust/<bot id>.json`, outside its folder, as path → SHA-256 of the content
Spade wrote there. The engine passes each call what the turn has read (`TurnFacts.untrusted`, from
`spade_core::context::untrusted_sources`), and:

- "Clean" here means the prompt the call was made from shows nothing untrusted:
  `TurnFacts.untrusted` comes from `spade_core::context::untrusted_in_view`, every untrusted event
  since the last `context_compacted` (`keep_from`), this turn's or an earlier one's, plus the
  summary when it was drawn from untrusted content. "Save that result" a turn after reading a
  page is therefore not clean. Notes and proposals take their `source` from the same view.
- `workspace_write` from a clean prompt records the path and hash; otherwise it removes the
  path. `workspace_edit` records the new hash only from a clean prompt and only when the file was
  trusted before (its old hash matched); otherwise it removes the path.
- Nothing else ever adds to the record: not the shell, not kept outputs, not the API.
- A file is trusted when its path is recorded with its current content's hash and it is a regular
  file reached through real folders only (no link on the way, not a link itself).
- `workspace_read` of a file that isn't trusted, `workspace_list` of a folder unless every entry
  shown is a trusted file (any folder or link entry makes it untrusted; an empty folder reached
  through real folders is trusted), and `workspace_search` unless every file it quotes is trusted
  answer with `tool_finished.untrusted: true`, which makes the rest of the turn untrusted like
  `web_fetch`.
- A `skill_feedback` note written in an untrusted turn keeps its `source`; `skill_load` showing it
  answers untrusted.

There is nothing to mark when a command runs, is stopped or times out, and no scan of the folder:
whatever a command made is simply not on the list. `tool_finished.untrusted` is absent when false;
`untrusted_sources` names each source ("https://example.com/page", `a web search for "…"`, "a
message from Research", "the file notes.md", "the output of `npm test`").

### Large output

A shell or search result over 16,000 characters is written to
`.spade/outputs/<conversation>-<call>.txt` in the workspace. The model gets the first and last
6,000 characters, how many were left out, and the file's path, to page through with
`workspace_read`.

## Spade's skill store

Every Spade keeps its own skills (`skill_store/`), so its bots have skills with ace away and on
Spade Cloud. Each skill is a folder, `<data folder>/skills/<id>/`, holding `SKILL.md` and the
skill's other files, and a row in Spade's SQLite (`skills`: id, origin, name, description,
manual, body, SKILL.md hash, the other files as `[{path, size, hash, executable}]`, source,
updated). Origins:

| Origin   | Id                    | What it is                                                                              |
| -------- | --------------------- | --------------------------------------------------------------------------------------- |
| `ace`    | the library's `skl_…` | A copy of a skill in ace's library; `source` is its scope; read only                    |
| `spade`  | `sks_` + 20 hex       | Written in Spade while ace was away, from a bot's saved proposal                        |
| `plugin` | `plg_` + 20 hex       | A plugin's skill or command ([plugins.md](plugins.md)); offered only to bots allowed it |
| `market` | `skm_` + 20 hex       | Installed from ace's marketplace (ADR 0168); `source` is its entry name; read only      |

A folder is always replaced whole: written as `.stage-<id>-<random>`, the old one moved to
`.old-<id>-<random>`, the new one renamed into place, the old one removed. On start, a
moved-aside folder whose skill has no folder is put back and everything else staged or aside is
removed.

**Mirroring ace's library.** While Spade is connected to ace, a background task lists the
library with `subscribe: true` (once per socket) and copies each skill whose SKILL.md hash
differs from its copy: `read` for SKILL.md, then `files` and each file by path; a file whose
bytes don't match the listed hash fails that copy and the old one stays. On a new connection it
also compares every skill's file list with its copy, since a file can change without SKILL.md;
the daemon's change notices only follow SKILL.md. It runs again on each `skills.changed`, when
the socket ends or Spade connects to another daemon, and every ten minutes. A skill the library
no longer lists is dropped, unless the listing was stale. Plugin-scope entries are skipped (their
files are the plugin's). With ace away the last copies are used, and nothing says so.

**Copying market skills.** The person installs a `spade-skill` entry in ace's marketplace; the
daemon pins it. While Spade is connected, a second background task sends `marketplace.request
{operation: {op: "spadeSkills"}}` for the installed skills and their pinned hashes, and for each
new or changed hash `{op: "spadeSkillFiles", name}` for the file list (`SKILL.md` among them),
then `{op: "spadeSkillFiles", name, path}` for each file (base64 in `content`). A file whose
bytes don't match its listed hash, or past ADR 0103's limits, fails that copy and the old one
stays; otherwise the copy is replaced whole. A skill the daemon no longer lists is dropped. It
runs on start, on each `marketplace.changed` the daemon pushes, when the socket ends or Spade
connects to another daemon, right after a bot is made from a recipe, and every ten minutes. With
ace away, or a daemon whose marketplace can't answer, the last copies stay and nothing says so.
Market skills serve every bot and are never edited in Spade.

**Several skills with one name** are offered once: ace's personal copy, then ace's other copies,
then a `spade` skill, then a market skill, then a plugin's.

**Saving goes to ace when ace is there.** A new skill (a saved proposal) is created in ace's
library while connected, then mirrored at once; with ace away (always on Cloud) it is written to
the store as a `spade` skill, refused when the store already has the name. An edit of a `spade`
skill stays in the store, checked against its SKILL.md hash. An edit of an ace skill goes to ace;
with ace away it is refused as unavailable and the proposal stays open. Spade never sends a
`spade` skill to ace on its own.

**Add to ace's library** (Settings › Spade › Skills, `POST /v1/skills/{id}/add-to-ace`) creates
a `spade` skill in ace's library for every agent, marks the row `added:<library id>`, and the
next mirror (run at once) drops the row once the library lists that id. A retry after a lost
answer only waits for that drop and never creates twice.

## Skills to and from the shared standard

ADR 0202 §1. A skill folder made to the [Agent Skills specification](https://agentskills.io/specification)
imports as a `spade` skill, and any skill the store keeps a folder for exports as one.
`@ace/marketplace`'s `skill-md.ts` is the one reader: the market's skill check, `ace bot check` and
both commands use it.

**What is checked.** `SKILL.md` starts with YAML front matter. `name`: 1–64 lower-case letters
and digits in runs joined by single hyphens, and the folder's own name. `description`: text, not
empty, at most 1,024 characters. `license`: text. `compatibility`: text, at most 500 characters,
shown and never a reason to refuse. `metadata`: keys with text values; `spade.` keys are Spade's
own. `allowed-tools`: tool names separated by spaces. Each problem names its line. Any other field
is kept and listed as "Not used by this Spade", never refused. The market's other skill checks
(secrets, limits, the scanner on market uploads) run as before.

**`allowed-tools` grants nothing.** The review and `ace bot check` say "It asks to run Bash and
Read without asking. Spade still decides each call." Spade never reads the field: it stays in
`SKILL.md`, and the gate reads every call a skill's instructions lead to as it reads any other.

**Import.** `ace spade skill import FROM [--git] [--path FOLDER] [--replace]` reads a folder, or
one folder of a git repository through the plugin fetcher (shallow bare fetch, isolated config,
no hooks, links and submodules refused), leaves hidden files out, and runs the checks above. Then
it sends `POST /v1/skills/import {name, description, manual, skill_md, files: [{path, executable,
content}], source, replace}`, with content as base64. Spade holds the name and description rules
again, a front matter start, `SKILL.md` at most 256 KiB, plain non-hidden paths inside the folder
listed once each, and ADR 0103's limits (512 files, 4 MiB each, 16 MiB together). It keeps
`SKILL.md` and every file byte for byte as a `spade` skill (`sks_` + 20 hex of the name), its
source `imported:<path or address>`. A name the store already holds is refused (409), unless
`replace` is set and the skill there was written in Spade. Imports are the person's alone
(ADR 0178 §12.5), like installs.

**Export.** `ace spade skill export SKILL [DIR]` reads `GET /v1/skills/{id}/export` (`{name,
origin, source, files}`, any origin but `plugin`, whose skills export with their plugin) and
writes `DIR/<name>/`, which must not exist. `SKILL.md` keeps the specification's fields and its
body as they were. Fields the specification doesn't define, which its validator refuses at the
top level, move under `metadata` as `spade.field.<name>` with their value as JSON. Two keys are
added: `spade.version` (`1`, the version of this mapping) and `spade.source` (`spade`, the import's
address, `market:<entry>` or `ace:<scope>`). Nothing else is added. The export is checked against
the validator's rules before anything is written.

**Round trip.** An import of an exported folder lifts `spade.field.*` back to the top level and
takes `spade.version` and `spade.source` out, so it stores the skill that was exported. A folder
with none of those keys is stored byte for byte.

## Loading a skill brings its files

`skill_load` answers with SKILL.md, then, when the skill has other files, the folder they are in
and each path with its size (and "runnable" for an executable one). The files are written into
the bot's workspace at `skills/<name>/` when the skill is loaded: kept as they are when the
folder holds exactly the skill's files (nothing else: no other file, link or empty folder), each
with the same content and still trusted; otherwise the folder is deleted, with the trust records
of everything in it, and written again, so nothing of an older version stays or stays trusted.
A skill with no other files has no folder: loading it removes one an older version left. Each file is written through the workspace
handle like any write, then made read only (`0444`, or `0555` for an executable one) through a
handle that does not follow links; on Windows files stay writable, since a read-only file there
could not be replaced or deleted when the skill changes. Each is recorded in the trust record
with its hash (`Trust::record_installed`): the person installed the skill, so `workspace_read`
of one answers trusted. A command that rewrites one changes its hash, and it reads as untrusted
like any other file a command changed. Scripts run with `shell`, under the same gate as any
command.

## Ranking

`spade_core::skills` is pure. `skill_search` scores each word of the query (two letters or
more) that begins a word of a skill's name (4), description (2) or body (1), the first place it
is found, times `ln(1 + skills / (1 + skills having the word))`, so a rare word counts more.
Equal scores (in thousandths) go to the skill the calling bot last marked helpful, then the one
it loaded more, then by name. Each bot's use is kept in `skill_uses` (loads, helpful), counted by
`skill_load` and set by `skill_feedback`, and deleted with the bot. The index frozen into a
conversation lists the 40 skills its bot loaded most, then by name.

## Skills a bot writes

Offered by every Spade, beside `skill_search` and `skill_load`, whether or not ace is there;
proposals are saved through the skill store above. Neither tool changes anything outside Spade,
so neither asks.

- `skill_propose {name, description, body, why?}`. `name` is a slug (`^[a-z0-9]+(-[a-z0-9]+)*$`,
  at most 64), `description` 1 to 1,024 characters, `body` (SKILL.md without frontmatter) at most
  250 KiB, `why` at most 2,000. When a library skill has the name: a personal, editable one makes
  the proposal an edit and stores its id, hash, description, body and `manual` as `base`; any
  other (built in, plugin, project) is refused. Proposing the skill exactly as it is is refused.
  The id is `sp_` and 20 hex digits of the SHA-256 of the call's key, so a retried call stores one
  proposal. A new proposal for a name replaces the bot's open one for it; a bot has at most 20
  open.
- `skill_feedback {name, verdict: "helpful"|"outdated", note?}` keeps the bot's latest verdict per
  skill, with `source` when the turn had read untrusted content. `skill_load` adds
  `Your note on it: …` after the skill when the bot left one.
- A proposal made in an untrusted turn keeps `source`; the app shows "Written after reading …"
  beside Save.

Proposals are `skills/proposals/<id>.json`, notes `skills/notes/<bot id>.json`, in the data
folder, each written whole through a temporary file. A bot's proposals and notes are deleted
with it.

**Answering** claims the proposal (one answer at a time; another gets `409`) before reading its
state. **Saving** records an `attempt` in the proposal file, then saves through the skill store:
with ace there it sends `skills.request` to the daemon over the socket Spade already reads skills
on: `create` with scope personal, every agent (`claude`, `codex`, `opencode`, `cursor`, `pi`) and
`manual: false`, or `edit` with `expectedHash` from `base` and its `manual`. Neither is resent
after a dropped socket. With ace away a new skill is written to the store instead. A refusal
(`conflict`, `exists`, any other typed error) clears the attempt and leaves the proposal open. No
answer (unreachable, timed out) leaves the attempt: the next Save or Discard first lists the
library and, when a skill of that name holds the proposal's description and body (compared
without trailing whitespace), settles the proposal as saved without writing; otherwise a new
skill is written again only if the name is still free, an edit only if the skill still has the
base hash. When the library holds something else under that name, or the edited skill is gone,
Save answers `409` ("Spade can't confirm the earlier save: …") and Discard still settles the
proposal as discarded, whatever the library says or even when it can't be reached. The daemon
request has no idempotency key; this reconciliation stands in for one.

## API

Under `/v1`, with the bearer token, as in [agents.md](agents.md).

**Entry** = `{"name", "path", "kind": "folder"|"file"|"link", "size", "modified_at"}` (`size` is 0
for folders and links). **Proposal** = `{"id", "agent", "call_id", "name", "description",
"body", "why", "base": {"id", "hash", "description", "body", "manual"}|null, "state":
"open"|"saved"|"discarded", "created_at", "answered_at", "skill_id", "source", "attempt":
{"id", "at"}|null}`.

| Method and path                                | Body / query     | Answer                                                                                                               |
| ---------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| `GET /agents/{id}/workspace`                   | `?path=`         | `{"path", "entries": [Entry], "truncated"}`; folders first                                                           |
| `GET /agents/{id}/workspace/file`              | `?path=`         | `{"path", "size", "text", "unreadable": null\|"binary"\|"too_large"}`                                                |
| `GET /agents/{id}/workspace/download`          | `?path=`         | The file's bytes, `application/octet-stream`                                                                         |
| `DELETE /agents/{id}/workspace`                | `?path=`         | `204`; a folder goes with what is in it; `422` for the workspace itself                                              |
| `GET /agents/{id}/skill-proposals`             |                  | `{"proposals": [Proposal]}`, oldest first, every state                                                               |
| `POST /agents/{id}/skill-proposals/{proposal}` | `{"save": bool}` | `200 {"proposal"}`; `409` answered already, being answered, or the skill changed or exists since; `503` library away |

| `GET /skills` | | `{"skills": [{"id", "name", "description", "origin", "manual", "files", "updated_at", "written_by", "used_by"}], "ace": bool}`; `ace` is whether Spade is connected now. `written_by`: the bots whose saved proposals wrote or changed a skill of that name; `used_by`: the bots that have loaded it (`skill_load`); bot ids, sorted. A bot's Library lists the skills naming it |
| `POST /skills/{id}/add-to-ace` | | `200 {"skill_id"}`; `404` unknown; `422` not a `spade` skill; `409` ace has the name; `503` ace away |
| `GET /skills/{id}/files` | | `200 {"name", "files": [{"path", "executable", "content"}]}`, `SKILL.md` first, content as base64, for publishing to ace's marketplace. Every folder and file is opened without following a link; SKILL.md is at most 1 MB, each file 4 MB, all of them 16 MB and 512 files. `404` unknown; `422` not a `spade` skill, a link, a special file or past a limit |

Workspace errors: `404` for an unknown agent or a missing path, `400` for a path that is absolute,
uses `..` or leads outside, `422` for a folder where a file is wanted and similar. The app places
a proposal's bubble after the reply that holds the call `call_id`.
