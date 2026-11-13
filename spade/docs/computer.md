# A bot's computer

Date: 2026-11-13. As built for [ADR 0142](../../docs/adr/0142-a-bots-computer.md), in
`spade-server` (`computer/`, `engine/computer.rs`, `api/computer.rs`, `api/files.rs`). Extends
[workspace.md](workspace.md) and [agents.md](agents.md).

Everything here is under `/v1`, needs the bearer token, and uses JSON. Unknown agent: `404`. A
Spade without computers: `503`.

## The computer

`GET /agents/{id}/computer` answers a **Computer**:

```json
{
  "driver": "bot" | "person",
  "thread_id": "string" | null,
  "surfaces": [
    { "kind": "browser" | "screen" | "terminal" | "files",
      "live": true, "title": "string" | null, "since": 0 | null,
      "url": "string", "tab_id": "string", "last": 0 | null }
  ]
}
```

- `terminal` and `files` are always there. `browser` and `screen` appear once the bot has used
  them or ace has reported them.
- `since` is when the surface became live (null when it isn't). `last` is when it was last used.
  `url` and `tab_id` are sent only when ace reported them.
- **browser, screen:** live while ace reports them live, or for 2 minutes after the bot's last
  call to one of ace's `browser_*` or `screen_*` tools. `title`, `url`, `tab_id` and the
  top-level `thread_id` (the hidden ace thread they run in) come from ace's report.
- **terminal:** live while its shell runs and either the person drives or something happened in
  it in the last 2 minutes. `title` is the bot's last command (its first line, 80 characters at
  most).
- **files:** live for 2 minutes after a change. `title` is the last changed path.

Each agent in `GET /agents` carries `computer` with the same object.

| Method and path                            | Body                                                        | Answer                    |
| ------------------------------------------ | ----------------------------------------------------------- | ------------------------- |
| `POST /agents/{id}/computer/take-over`     |                                                             | `204`; again changes nothing |
| `POST /agents/{id}/computer/hand-back`     |                                                             | `204`; again changes nothing |
| `PUT /agents/{id}/computer/surfaces/{kind}` | `{"live", "title"?, "url"?, "tab_id"?, "thread_id"?, "person_acted"?}` | `204`; ace only, `kind` is `browser` or `screen` |

**Taking over** saves `<data folder>/computer/<agent>.json` (the conversation, a snapshot of the
workspace of at most 5,000 entries, the lines entered and surfaces used so far). It then pauses
the bot's open turn at its next safe point: a streaming step finishes, tools cut off are answered
"may have run", and `turn_paused` is stored. Messages sent meanwhile are stored without opening a
reply. A working bot's status is `Paused while you have the computer`. Stop still closes the
reply.

**Handing back** stores `{"type":"computer_handed_back","text"}`, removes the file, and resumes:
the paused turn carries on, or the waiting messages open a reply. The note doesn't open a reply
by itself. `text` lists the lines the person entered at the shell's prompt (50 at most, then a
count), the workspace files new, changed or removed since the take-over (30 at most, then a
count), and "They used your browser/screen" when ace reported `person_acted`. The model reads it
as `<computer_handed_back from="spade">…</computer_handed_back>`, after the results of any calls
still open, like a job's result. The app may show it as a small system line.

A line counts as entered at the prompt when the terminal's foreground process group is the
shell's at the moment the person presses Return. A line typed into a running program (`sudo`'s
password prompt) is never kept. Tab completion and history are the shell's, so a line is what
the person typed, not always what ran.

## The terminal

On macOS and Linux each bot has one `/bin/sh -i` in a pseudo-terminal (`portable-pty`), started
in its workspace when first used. Its environment is the one-shot shell's (see
[workspace.md](workspace.md)) with `TERM=xterm-256color` and `PS1='$ '`. The size starts at
120×32. The last 2 MiB of output is kept as numbered chunks. Numbers start from the clock, so
they keep growing across Spade restarts.

The shell is ended (with everything in its session: `kill -KILL` on its group, then
`pkill -KILL -s <session>`) after 6 hours without use, unless the person has the computer. It is
also ended when the bot is deleted and when Spade stops. The next use starts a new one.

| Method and path                      | Body / query         | Answer                                                         |
| ------------------------------------ | -------------------- | -------------------------------------------------------------- |
| `GET /agents/{id}/terminal/live`     | `?after=N`           | SSE (below); starts the shell if it isn't running              |
| `POST /agents/{id}/terminal/input`   | `{"data_b64"}`       | `204`; `409` unless the person drives; `413` past 64 KiB       |
| `POST /agents/{id}/terminal/resize`  | `{"cols", "rows"}`   | `204`; clamped to 2–1000 × 1–1000                              |

SSE events: first `resize {"cols","rows"}`, then each kept `output {"seq","data_b64"}` with `seq`
above `after`, then live frames: `output`, `resize`, and `exit {"code": int|null}` when the shell
ends (the stream stays open, and a new shell's output follows). A viewer that falls behind is
closed and comes back with its last `seq`.

### The bot's `shell` tool

On macOS and Linux it runs in the terminal. Asking, "always" for the exact command, the timeouts,
the 4 MiB output cap, large output kept as a file, and untrusted output are all as in
[workspace.md](workspace.md). How a command runs:

1. One command at a time per bot. It is refused (an error result) while the person has the
   computer, and while a program other than the shell holds the foreground.
2. The command goes to `<data folder>/terminal/<agent>/<nonce>.cmd`, plus a runner `<nonce>.sh`:
   `printf` of `ESC ]777;spade;<nonce>;start BEL`, `. '<nonce>.cmd' </dev/null`, then `printf` of
   `ESC ]777;spade;<nonce>;end;$? BEL`. The terminal gets Ctrl-U (dropping anything half typed),
   then ` . '<nonce>.sh'`.
3. The output between the markers, with escape sequences removed, `\r\n` as `\n` and redrawn
   lines kept as last drawn, is what the model reads. stdout and stderr arrive merged, so there
   is no `[stderr]` part. Both files are removed afterwards.
4. Past the deadline it gets Ctrl-C, then after 1 s the foreground job's group is killed. If the
   shell itself exits (`exit`), the result says so and the next command starts a new one.

On Windows the `shell` tool runs each command on its own, as in workspace.md, and the terminal
routes answer `503`.

## Files

The workspace routes in [workspace.md](workspace.md) (list, open, download, delete) stay. Added:

| Method and path                    | Body                          | Answer                                                |
| ---------------------------------- | ----------------------------- | ----------------------------------------------------- |
| `PUT /agents/{id}/files?path=`     | `{"text"}` or `{"data_b64"}`  | `204`; writes or replaces the file                    |
| `POST /agents/{id}/files/upload`   | `{"path", "data_b64"}`        | `204`                                                 |
| `POST /agents/{id}/files/mkdir`    | `{"path"}`                    | `204`; makes folders on the way; a file there is `422` |
| `POST /agents/{id}/files/move`     | `{"from", "to"}`              | `204`; `409` when `to` exists; never into itself       |

- Files are 32 MiB at most (`413`).
- Writes go through a temporary file renamed into place, as for the tools. A file the person
  writes or uploads is recorded as trusted (path and SHA-256 in the trust record). A move carries
  the trust of what moved, files inside a moved folder included.
- Errors as for the workspace: `400` for a path that is absolute, uses `..` or leads outside,
  `404` when missing, `409` as above, `422` for other refusals (a link on the way that leads out
  can answer `400` or `422`; nothing is written either way).

## Live frames

The conversation's `GET /conversations/{id}/live` adds, for a bot:

- `computer`: the Computer object. Sent once on connect, after `status`, and again on every
  change: driver, a surface going live or quiet, a new title.
- `files {"paths": [string] | null}`: the workspace changed. `null` means Spade can't say which
  files (a bot command ran, or the person entered a line in the terminal), so re-read. Sent for
  the person's file routes, `workspace_write`, `workspace_edit` and every bot shell command.
