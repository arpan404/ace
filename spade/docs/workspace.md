# Workspaces and skills a bot writes

Date: 2026-11-12. As built for [ADR 0130](../../docs/adr/0130-spade-skills-and-workspace.md), in
`spade-server` (`workspace/`, `learning/`, `api/workspace.rs`). Extends [harness.md](harness.md)
and [agents.md](agents.md).

## The workspace

Each bot has a folder, `<data folder>/workspace/<bot id>/`, created the first time a tool or the
app uses it and deleted with the bot. Paths given to the tools and the API are relative to it,
with `/`. A path is refused when it is absolute, starts with `~`, uses `..`, or resolves outside
the folder after following symlinks (for a write, every existing folder on the way and the file
itself are checked before anything is created).

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

- `/bin/sh -c <command>` on macOS and Linux, `cmd.exe /D /S /C <command>` on Windows
  (`workspace/shell.rs`, the one platform branch).
- Its own process group (`process_group(0)`; on Windows a new process group, killed as a tree with
  `taskkill /T /F`). The group is killed when the deadline passes (default 60 s, `timeout_s` up to
  110 s, inside the harness's 120 s limit) and again when the run ends, so background processes
  it started never stay.
- Environment: cleared, then `PATH`, `LANG`, `TMPDIR`, `USER`, `LOGNAME` from Spade's own (POSIX)
  or `PATH`, `PATHEXT`, `SystemRoot`, `SystemDrive`, `windir`, `ComSpec`, `TEMP`, `TMP`
  (Windows), plus `HOME` (and `USERPROFILE`) set to the workspace, `TERM=dumb`, `SHELL=/bin/sh`.
  Nothing else of Spade's environment reaches it: not its token, endpoint keys or ace's grant.
- stdin is empty; stdout and stderr are each kept up to 4 MiB. The model reads `Exit code N.`
  (or how it was stopped), stdout, then `[stderr]` and stderr. A command that timed out or exited
  non-zero is an error result.

**Asking.** A shell call is a write unless its command is on the allowlist
(`workspace/allow.rs`): `ls`, `cat`, `head`, `tail`, `wc`, `grep`, `pwd`, `echo`, `stat`, `du`,
`diff`, `tree` (not `-o`), `date` (not `-s`), `find` (not `-exec`, `-execdir`, `-ok`, `-okdir`,
`-delete`, `-fprint*`, `-fls`) and `git status|log|diff|show` (not `--output`, `-o`,
`--ext-diff`, `--textconv`, and no option before the subcommand), with none of
`; & | < > $ \` ( ) { } \` or line breaks, balanced quotes, and no argument that is absolute,
starts with `~` or uses `..`. Allowlisted commands are reads and run without asking. Any other
command asks; answering one with `always` allows the bot's later commands too (approvals are per
tool and per conversation, and each bot has one). In a turn that read untrusted output every
non-allowlisted command asks, `always` or not. On Windows every command asks.

To support this, a tool may judge one call's risk from its arguments (`Tool::risk_of`); the gate
and the stored `tool_started` use that risk.

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
  skill. `skill_load` adds `Your note on it: …` after the skill when the bot left one.

Proposals are `skills/proposals/<id>.json`, notes `skills/notes/<bot id>.json`, in the data
folder, each written whole through a temporary file. A bot's proposals and notes are deleted
with it.

**Saving** sends `skills.request` to the daemon over the socket Spade already reads skills on:
`create` with scope personal, every agent (`claude`, `codex`, `opencode`, `cursor`, `pi`) and
`manual: false`, or `edit` with `expectedHash` from `base` and its `manual`. Neither is resent
after a dropped socket. A refusal leaves the proposal open.

## API

Under `/v1`, with the bearer token, as in [agents.md](agents.md).

**Entry** = `{"name", "path", "kind": "folder"|"file"|"link", "size", "modified_at"}` (`size` is 0
for folders and links). **Proposal** = `{"id", "agent", "call_id", "name", "description",
"body", "why", "base": {"id", "hash", "description", "body", "manual"}|null, "state":
"open"|"saved"|"discarded", "created_at", "answered_at", "skill_id"}`.

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
