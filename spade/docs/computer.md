# A bot's computer

Date: 2026-11-13. As built for [ADR 0142](../../docs/adr/0142-a-bots-computer.md) and
[ADR 0143](../../docs/adr/0143-cowork-computer-use.md) (cowork), in
`spade-server` (`computer/`, `engine/computer.rs`, `api/computer.rs`, `api/files.rs`). Extends
[workspace.md](workspace.md) and [agents.md](agents.md).

Everything here is under `/v1`, needs the bearer token, and uses JSON. Unknown agent: `404`. A
Spade without computers: `503`.

## The computer

`GET /agents/{id}/computer` answers a **Computer**:

```json
{
  "mode": "cowork" | "exclusive",
  "driver": "bot" | "person",
  "stopping": false,
  "thread_id": "string" | null,
  "surfaces": [
    { "kind": "browser" | "screen" | "terminal" | "files",
      "live": true, "title": "string" | null, "since": 0 | null,
      "url": "string", "tab_id": "string", "ending_stuck": true, "last": 0 | null,
      "person_active": false }
  ]
}
```

- `mode` is `cowork` (the default: the person and the bot use the computer at once) or
  `exclusive` (the person took over and the bot is paused). `driver` follows it: `bot` in cowork,
  `person` in exclusive mode. See [Cowork](#cowork) below.
- `person_active`: the person is using that surface now. Terminal and files: they typed or changed
  a file through the app in the last 10 s. Browser and screen: ace's last report said so
  (`person_active`), or ace said they acted in the last 10 s.

- `stopping` is true while the person drives and some of the bot's work is still being stopped:
  a command in its terminal, or a call ace hasn't yet seen end. ace's answer to
  `driver: "person"` says `stopped: false` when a bot call was still running after its 12 s
  wait, and every round asks again. The app shouldn't give the person the controls until it is
  false. Without ace it is only the terminal.
- `ending_stuck` (terminal only, absent when false): the last bot command's processes were not
  all ended within 30 s, and that is still going on. The terminal is let go, so a take-over
  finishes (`stopping` turns false) and the person can deal with it. Every bot command is
  refused ("Not run: the terminal is still ending earlier work") until the end is done, then the
  flag clears. The app can show it on the terminal tile.
- `terminal` and `files` are always there. `browser` and `screen` appear once the bot has used
  them or ace has reported them.
- `since` is when the surface became live (null when it isn't). `last` is when it was last used.
  `url`, `tab_id` and `backend` are sent only when ace reported them. `backend: "user"` marks a tab
  in the person's own browser, which ace doesn't stream; any value is passed on as it is.
- **browser, screen:** live while ace reports them live, or for 2 minutes after the bot's last
  call to one of ace's `browser_*`, `screen_*` or `sim_*` tools (a simulator counts as the screen). `title`, `url`, `tab_id` and the
  top-level `thread_id` (the hidden ace thread they run in) come from ace's report.
- **terminal:** live while its shell runs and either the person drives or something happened in
  it in the last 2 minutes. `title` is the bot's last command (its first line, 80 characters at
  most).
- **files:** live for 2 minutes after a change. `title` is the last changed path.

Each agent in `GET /agents` carries `computer` with the same object.

| Method and path                            | Body                                                        | Answer                    |
| ------------------------------------------ | ----------------------------------------------------------- | ------------------------- |
| `POST /agents/{id}/computer/take-over`     |                                                             | `204`; exclusive mode; again changes nothing |
| `POST /agents/{id}/computer/hand-back`     |                                                             | `204`; back to cowork; again changes nothing |
| `PUT /agents/{id}/computer/surfaces/{kind}` | `{"live", "title"?, "url"?, "tab_id"?, "thread_id"?, "person_acted"?, "person_active"?, "mode"?}` | `204`; ace only, `kind` is `browser` or `screen` |

Take-over and hand-back are the switch between the modes; there is no separate mode route. The
mode is `exclusive` exactly while the take-over record below exists, so it survives restarts with
it, and cowork needs nothing stored. A report's `mode` is ace's view and is not used: Spade's
record is the truth, and the resync below brings ace back in line.

## Cowork

The default. The bot is not paused and keeps answering. The person:

- types into the terminal's shell at once (no take-over). Their shell and the bot's commands are
  separate processes, and a bot command's input is `/dev/null`, so nothing they type reaches it.
- changes files through the app at once, checked against the revision they opened (see
  [Files](#files)).
- uses the browser and screen through ace. ace makes a bot's action there wait while the person
  is active on the same tab or screen (3 s after their last input), up to 60 s; then it answers
  `person_busy`, and Spade tells the model "Not run: the person is using this part of your
  computer … they come first … don't retry it straight away". Not a failure; reads never wait.

**The bot yields files.** A bot `workspace_write` or `workspace_edit` of a file the person
changed through the app in the last 30 s is not run: "Not run: the person changed `<path>` N
seconds ago … read it again before you change it". It is a result, not an error.

- "The same file" is by identity, not by the path as written: the path with links in its folders
  followed, compared without case on a volume that ignores case (found by looking up the
  workspace folder's own name with its case swapped), or the same device and inode where the
  file exists. So `Notes.txt` and `notes.txt` on such a volume, or `alias/a.txt` through a link
  to `real/`, are one file, and a file the person deleted still counts when the bot makes it
  again. Linux folders with case folding switched on (ext4 `casefold`) are not detected; there
  the inode still matches a file that exists.
- The changes and their times are kept in `<data folder>/computer/recent/<bot>.json` (replaced
  whole through a temporary file, without waiting for the disk), so a restart keeps the window.
  Expired entries are dropped when it is read. Changes made in exclusive mode count too.

**One lock per workspace.** The person's file routes (write, upload, mkdir, move, delete) and the
bot's file tools (`workspace_write`, `workspace_edit`) each run their checks (mode, stopping, the
revision, the person's recent changes), their change and its record while holding the
workspace's file lock. So neither lands between the other's check and its write: when both go
for the same file at once, exactly one wins and the other gets `409 changed` or "Not run".
**Terminal commands can't take this lock.** They are other processes, the bot's and the
person's alike, and Spade can't see which files they touch. A command can change a file between
the person's revision check and their write, and nothing a command does is yielded.

**The bot hears what the person did, as it happens.** Spade gathers it per bot: the surfaces they
used (the terminal when they typed, never what; the browser and screen when ace reports
`person_acted`), the files they changed through the app (`changed`, `new`, `removed`), and the
browser's address when ace reports they acted there (10 at most). Before each model step, never
mid-call, the engine stores `{"type":"person_activity","text","data"?}` when there is something
and the last one was at least 60 s ago; what came meanwhile waits for a later step. Nothing is
stored while the bot isn't working: it waits for its next turn. It opens no reply by itself.

- `text` is Spade's words ("They used your terminal (their own shell, not yours)", "They changed
  2 files …", "In your browser they were on 1 address …", "The person comes first …").
- `data` holds the names, `changed: path` or `went to: address`, kept apart exactly as a
  hand-back's are, and makes the event untrusted content like a fetched page.
- The model reads `<person_activity from="spade">…</person_activity>`, then, with data,
  `<activity_data untrusted="true">` with the names as a JSON array. A bot on a subscription
  (CLI brain) gets the same text in its next turn's message, once, as it gets a hand-back note.
- What was gathered lives in memory: a restart loses a summary not yet offered.

In exclusive mode none of this is gathered: the take-over record collects it for the hand-back
note as before.

## Exclusive mode (take over)

**Taking over** saves `<data folder>/computer/<agent>.json` (the conversation, a snapshot of the
workspace of at most 5,000 entries, and the surfaces used so far). It then pauses
the bot's open turn at its next safe point: a streaming step finishes, tools cut off are answered
"may have run", and `turn_paused` is stored. Messages sent meanwhile are stored without opening a
reply. A working bot's status is `Paused while you have the computer`. Stop still closes the
reply.

**Handing back** stores `{"type":"computer_handed_back","text","data"?}`, removes the file, and
resumes: the paused turn carries on, or the waiting messages open a reply. The note doesn't open
a reply by itself.

- `text` is Spade's words: about how long the person had the computer, which surfaces they used
  ("They used your terminal" once they typed in it, browser and screen as ace reported), how many
  workspace files are new, changed or removed since the take-over, and how many addresses they
  visited, opened or closed in the browser. Nothing the person typed is ever in it, or anywhere
  Spade keeps or sends: their input goes to their shell and nowhere else.
- `data` holds the names themselves, `new: path` or `went to: address` (30 files at most, 10
  addresses per list), because whoever made a file or a page chose its name. A hand-back with
  `data` counts as untrusted content for the rest of the conversation's view, exactly like a
  fetched page (approvals, notes, proposals).
- The model reads `<computer_handed_back from="spade">…</computer_handed_back>`, then, when there
  is data, `<handback_data untrusted="true">` with the names as a JSON array. It comes after the
  results of any calls still open, like a job's result. The app may show it as a small system
  line.

## ace's side: browser and screen

The daemon keeps each bot's browser and screen in a hidden thread of its own
(`packages/protocol/src/spade-computer.ts`).

- **Acting for a bot.** Every ace MCP `tools/call` Spade makes for a bot carries
  `_meta: {"ace/acting-for": "<agent id>"}`. CLI bots' `spade_call`s that reach ace's tools carry
  it too. The id comes from the call's key, which Spade made for the turn, never from the model's
  arguments. ace honours it on Spade's grant only.
- **Modes.** Every `spade.computer.drive` names both `driver` and `mode`: `person` with
  `exclusive` for a take-over, `bot` with `cowork` for a hand-back. A daemon that knows modes goes
  by `mode`; an older one by `driver`. Bots never taken over are never sent one: cowork is the
  daemon's default. In cowork the daemon PUTs `person_active` (used in the last 3 s) and
  `person_acted` on its surface reports, and answers a bot's action it waited 60 s for with
  `person_busy` (see [Cowork](#cowork)).
- **While the person drives**, ace answers the bot's `browser_*` and `screen_*` calls with the
  public error `person_driving`. Spade gives the model a not-run result that is not an error ("the
  person took over your computer … don't retry"), so it never counts as a failure to try again.
- **Take-over** also sends `spade.computer.drive {requestId, bot, driver: "person"}` over the
  daemon's loopback socket, after answering the person: ace answers once the bot's calls in
  flight have ended (up to 10 s), so Spade waits up to 20 s and tolerates a failure. **Hand-back** first sends
  `driver: "bot"`. The answer's `handback {drivenMs, visited, opened, closed, screenUsed}` goes
  into the note as addresses only, never page titles, which are the pages' own text: at most 10
  per list, 200 characters each, no spaces or backticks. "They used your screen" is added when
  `screenUsed`. When ace can't be reached the note goes without it, and the bot is marked as
  releasing. A take-over's answer carries `stopped`. `false` keeps `stopping` set until a later
  round answers `true`; an answer without it counts as stopped.
- **Kept in step.** The daemon keeps the driver in memory only. Every 10 s Spade sends
  `driver: "person"` again for every bot the person has, and `driver: "bot"` for every hand-back
  ace hasn't confirmed (or that ace still shows as the person's), so a daemon that restarted
  learns it back.
- **At start** Spade reads every bot's `spade.computer.get` until each answers: `threadId` becomes
  `thread_id`, the last tab becomes the browser surface (`title`, `url`, `tab_id`), and apps in
  use make the screen live (`title` is the apps, comma-joined). After that the daemon's
  `PUT …/computer/surfaces/{kind}` reports keep them current.

## The terminal

On macOS and Linux each bot has one `/bin/sh -i` in a pseudo-terminal (`portable-pty`), started
in its workspace when first viewed or typed in. It is the person's. Its environment is the
one-shot shell's (see [workspace.md](workspace.md)) with `TERM=xterm-256color` and `PS1='$ '`.
The size starts at
120×32. The last 2 MiB of output is kept as numbered chunks. Numbers start from the clock, so
they keep growing across Spade restarts.

The shell is ended (with everything in its session: `kill -KILL` on its group, then
`pkill -KILL -s <session>`) after 6 hours without use, unless the person has the computer. It is
also ended when the bot is deleted and when Spade stops. The next use starts a new one.

| Method and path                      | Body / query         | Answer                                                         |
| ------------------------------------ | -------------------- | -------------------------------------------------------------- |
| `GET /agents/{id}/terminal/live`     | `?after=N`           | SSE (below); starts the shell if it isn't running              |
| `POST /agents/{id}/terminal/input`   | `{"data_b64"}`       | `204` in either mode; `409` in exclusive mode while a bot command is still stopping; `413` past 64 KiB |
| `POST /agents/{id}/terminal/resize`  | `{"cols", "rows"}`   | `204`; clamped to 2–1000 × 1–1000                              |

SSE events: first `resize {"cols","rows"}`, then each kept `output {"seq","data_b64"}` with `seq`
above `after`, then live frames: `output`, `resize`, and `exit {"code": int|null}` when the shell
ends (the stream stays open, and a new shell's output follows). A viewer that falls behind is
closed and comes back with its last `seq`.

### The bot's `shell` tool

On macOS and Linux it is shown in the terminal and keeps its folder and variables between
commands. Asking, the timeouts, the 4 MiB output caps, the
`[stderr]` part, large output kept as a file, and untrusted output are all as in
[workspace.md](workspace.md). A bot command never goes through the person's shell:

1. One command at a time per bot. It is refused (an error result) in exclusive mode. In cowork
   it runs while the person types in their shell.
2. It runs as the one-shot shell does: `/bin/sh -c`, its own process group, the built
   environment, stdin from `/dev/null`. Two things change. It starts in the folder the bot's last
   command ended in (the workspace at first), and with the variables that command exported. These
   are never carried: `PATH`, `HOME`, `SHELL`, `ENV`, `BASH_ENV`, `IFS`, `CDPATH`, the prompts,
   `TERM`, `PWD`, `TMPDIR`, `LANG`, `USER`, `LOGNAME`, `LD_*`, `DYLD_*`, `BASH_FUNC_*`,
   `SPADE_*`. At most 200 variables (64 KiB) are carried.
   An `EXIT` trap writes the folder and `env -0` to two files in
   `<data folder>/terminal/<agent>/`, which Spade reads and removes.
3. Its output goes to the model as before, and is copied into the terminal's view as it comes,
   after a `[bot] $ <first line>` line and before `[bot] exit N`.
4. A supervisor owns it, so it ends when its process ends. Past the deadline, or when the call is
   dropped (a take-over or Stop), its whole process group is killed, the supervisor waits (up to
   5 s) until no process is left in it, and only then does the next command start or the person
   get to type. That holds when the call is dropped while its processes are still being ended,
   too. Completion is the process's own exit, so nothing a command prints can end it early. When
   the end takes longer than 30 s, the terminal is quarantined (`ending_stuck` above) rather
   than held, so the person is never locked out of it.
5. **Everything it started ends with it, sessions of their own included.** At its end (by
   deadline, drop or finish) the processes that are provably the command's are chosen:
   - the leader, while it is not yet reaped;
   - the live descendants of anything chosen, by parent chain;
   - the members of its process group (on macOS only those started while it ran, so a later
     group that reused the number is not taken);
   - on Linux, orphans Spade adopted as child subreaper (`PR_SET_CHILD_SUBREAPER`, parent is
     Spade) that carry this run's `SPADE_RUN=<random>`, which everything the command starts
     inherits. The mark alone never chooses a process.

   Each one is recorded with its identity when found: a pidfd on Linux, which every signal goes
   through, and its start time on macOS, to the microsecond (`proc_pidinfo(PROC_PIDTBSDINFO)`,
   `pbi_start_tvsec` and `pbi_start_tvusec`), checked again right before every signal and skipped
   on a mismatch. So a pid another process has taken is never signalled, and the leader's number is
   never used once reaped. Everything chosen is stopped (`SIGSTOP`). The look is repeated until
   nothing new turns up and each one is *seen* stopped or gone (Linux `/proc/<pid>/stat` state
   `T`/`t`/`Z`/`X`, macOS `pbi_status` `SSTOP`/`SZOMB`), then all of it is killed. Adopted ones are reaped,
   each by its own pid, never `waitpid(-1)`. When that doesn't settle within 8 passes, what is
   known is killed anyway, the end is logged, the tool result adds "Not every process this
   command started could be seen to stop; some may still be running", and the terminal starts
   afresh (a new shell, nothing carried).

   **The limits.** On macOS, a process that detached (`setsid`) and was reparented away before
   the end can survive, such as a daemon left by a command that finished. macOS shows no other
   process's environment and has no subreaper. On Linux, only one that also cleared its
   environment and started another program before its parent exited can.
6. **"Always" holds only in the state it was given in.** Answering `always` covers the exact
   command run from the same folder with the same carried variables. The approval stores that
   scope (`approval_requested.scope`: the command and a digest of the folder and variables), and
   when either has changed, the same command asks again. A carried `NODE_OPTIONS` or `PYTHONPATH`
   would change what it runs. The scope a call was allowed with, always or by the person's
   answer, is checked again under the terminal's command lock, right before it runs. When an
   earlier call in the same response, or a restart, changed the state since, the call is not run.
   Its result says so ("Not run: your terminal's folder or carried variables changed…"), and the
   model's next call of it asks. A call is never asked again in place, because its start is
   already stored by then.

On Windows the `shell` tool runs each command on its own, as in workspace.md, and the terminal
routes answer `503`.

## Files

The workspace routes in [workspace.md](workspace.md) (list, open, download, delete) stay. Added:

| Method and path                    | Body                          | Answer                                                |
| ---------------------------------- | ----------------------------- | ----------------------------------------------------- |
| `PUT /agents/{id}/files?path=`     | `{"text"}` or `{"data_b64"}`, `"base"?` | `204`; writes or replaces the file          |
| `POST /agents/{id}/files/upload`   | `{"path", "data_b64", "base"?}` | `204`                                               |
| `POST /agents/{id}/files/mkdir`    | `{"path"}`                    | `204`; makes folders on the way; a file there is `422` |
| `POST /agents/{id}/files/move`     | `{"from", "to", "base"?}`     | `204`; `409` when `to` exists; `422` to another disk; never into itself |
| `DELETE /agents/{id}/workspace?path=&base=` |                      | `204`; `base` optional                                |

- **Revisions.** `GET /agents/{id}/workspace/file` answers `revision`: `sha256:<hex>` of the
  file's content (absent past 32 MiB). A write, upload, move or delete may send it back as
  `base`. When the file at `path` (a move's `from`) is no longer that revision, or is gone, the
  route answers `409 {"error":"changed","code":"changed","message","revision"}` (`revision` is
  the file's now, or null when it is gone or has grown past 32 MiB) and changes nothing. Without `base` the change goes ahead: a new file,
  or the person chose to overwrite. A `base` for a folder is `422`.
- Reading and downloading always work. In cowork every file change works at once. In exclusive
  mode a change also needs `stopping: false`, else `409` with the terminal input route's error
  shape. The checks run under the workspace's file lock and the computer lock right before the
  change, holding both through it (see "One lock per workspace" above).
- Files are 32 MiB at most (`413`).
- Writes go through a temporary file renamed into place, as for the tools. A file the person
  writes or uploads is recorded as trusted (path and SHA-256 in the trust record). A move carries
  the trust of what moved, files inside a moved folder included.
- A move is one rename that refuses a taken target: `renameat2(RENAME_NOREPLACE)` on Linux,
  `renamex_np(RENAME_EXCL)` on macOS. So something made at the target a moment before is never
  replaced, and nothing put at the source is lost. On Windows, which has no such rename, Spade
  checks the target and then renames, so something made there in between can be replaced.
- Errors as for the workspace: `400` for a path that is absolute, uses `..` or leads outside,
  `404` when missing, `409` as above, `422` for other refusals (a link on the way that leads out
  can answer `400` or `422`; nothing is written either way).

## Live frames

The conversation's `GET /conversations/{id}/live` adds, for a bot:

- `computer`: the Computer object. Sent once on connect, after `status`, and again on every
  change: driver, a surface going live or quiet, a new title.
- `files {"paths": [string] | null}`: the workspace changed. `null` means Spade can't say which
  files (a bot command ran, or the person typed in the terminal), so re-read. Sent for
  the person's file routes (a move names both paths, a delete its path), `workspace_write`,
  `workspace_edit` and every bot shell command.
