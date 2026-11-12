# Workspaces and skills a bot writes

Date: 2026-11-12. As built for [ADR 0130](../../docs/adr/0130-spade-skills-and-workspace.md), in
`spade-server` (`workspace/`, `learning/`, `api/workspace.rs`). Extends [harness.md](harness.md)
and [agents.md](agents.md).

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

- `/bin/sh -c <command>` on macOS and Linux, `%SystemRoot%\System32\cmd.exe /D /S /C <command>`
  on Windows (`workspace/shell.rs`, the one platform branch).
- Contained: on macOS and Linux its own process group (`process_group(0)`), killed with
  `kill -KILL -<group>`; on Windows a job object with kill-on-close, which the command is assigned
  to as it starts (anything it starts in the moment before that is not held). Everything is
  killed when the deadline passes (default 60 s, `timeout_s` up to 110 s, inside the harness's
  120 s limit) and again when the run ends however it ends (finished, timed out, or the call
  dropped by Stop or the harness), and the output readers are aborted with it.
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

- `workspace_write` in a clean turn records the path and hash; in a tainted turn it removes the
  path. `workspace_edit` records the new hash only in a clean turn and only when the file was
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

## Skills a bot writes

Offered when Spade has a skill library (ace is configured), beside `skill_search` and
`skill_load`. Neither tool changes anything outside Spade, so neither asks.

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
state. **Saving** records an `attempt` in the proposal file, then sends `skills.request` to the
daemon over the socket Spade already reads skills on: `create` with scope personal, every agent
(`claude`, `codex`, `opencode`, `cursor`, `pi`) and `manual: false`, or `edit` with
`expectedHash` from `base` and its `manual`. Neither is resent after a dropped socket. A refusal
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

Workspace errors: `404` for an unknown agent or a missing path, `400` for a path that is absolute,
uses `..` or leads outside, `422` for a folder where a file is wanted and similar. The app places
a proposal's bubble after the reply that holds the call `call_id`.
