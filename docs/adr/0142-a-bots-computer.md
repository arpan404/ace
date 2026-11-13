# 0142: A bot's computer

Status: accepted. Date: 2026-11-13. Decided by: the owner (2026-11-13: "i want full computer
control and terminal, files, etc.", the pinned live view design). Builds on
[ADR 0123](0123-spade-runs-as-its-own-service.md) (Spade's service and data folder),
[ADR 0126](0126-spade-agents.md) (bots, one conversation each),
[ADR 0127](0127-spade-main-bot-and-chat.md) (the chat),
[ADR 0130](0130-spade-skills-and-workspace.md) (the workspace, the shell, trust as an allowlist)
and [ADR 0133](0133-spade-cli-brains.md) (bots on the person's subscriptions).

## Context

A Spade bot already acts on a machine: it runs commands in its workspace, keeps files there and
drives ace's browser and computer-use tools. The person sees none of it while it happens. They
read tool results afterwards in the chat. They can't watch the bot work, and they can't step in
to help (sign in to a site, fix a command that keeps failing) without stopping the bot and
explaining in a message.

The person wants the bot's work to look like work on a computer they can see, and that they can
take over.

## Decision

### Surfaces

1. **Each bot has a computer with four surfaces.** `browser` is the tabs in ace's browser that
   the bot drives. `screen` is computer use on its machine, through ace. `terminal` is one
   persistent interactive shell in its workspace. `files` is the workspace itself. The app shows
   a surface live, pinned beside the conversation, while the bot uses it.
2. **Each side streams what it owns.** Spade streams the terminal and the files: the terminal as
   output over SSE, files as change events on the conversation's live stream. The ace daemon
   streams the browser and the screen (pictures and input), in its own thread for the bot. Spade
   knows when a bot uses its browser or screen because the bot calls ace's tools through Spade.
   ace reports the rest (that the surface is live, its title, page, tab and thread, and that the
   person acted in it) to Spade's API with Spade's token. `GET /v1/agents/{id}/computer` returns
   the union, so the app reads one object.

3. **ace knows which bot is acting.** Every call Spade makes to ace's tools for a bot names it
   in `_meta` (`ace/acting-for`), taken from Spade's own state for the turn, never from the
   model's arguments. That is how each bot gets its own browser and screen thread in ace.

### The terminal

4. **One shell per bot, kept between commands.** An interactive `/bin/sh` in a pseudo-terminal,
   started in the bot's workspace with the same clean environment as the one-shot shell of
   ADR 0130 (none of Spade's secrets, system folders on `PATH`, `HOME` the workspace) plus a
   terminal type. It is the person's. The last 2 MiB of output is kept for viewers. The shell is ended after 6 hours unused, unless the
   person has the computer; it is also ended when the bot is deleted and when Spade stops, and
   everything in its session goes with it. The next use starts a new one.
5. **The bot's `shell` commands show in that terminal and keep their state.** A bot command
   never goes through the person's shell. Each runs as Spade's own child, as the one-shot shell
   of ADR 0130 does (its own process group, stdin from `/dev/null`). It starts in the folder the
   last one ended in, with the variables it exported, never those that decide which program a
   name runs (`PATH`, `LD_*`, `DYLD_*` and the like), and its output is copied into the
   terminal's view. A supervisor owns each command: when the command finishes, times out or is
   dropped (by a take-over or Stop), everything it started is gone before the next command
   starts or the person types. That includes children in sessions of their own: each command
   carries a mark its descendants inherit, and its tree is frozen and then killed (on Linux,
   Spade is also a child subreaper). On macOS a process that detached and was reparented away
   before the end, such as a daemon left by a finished command, can survive. Completion is the
   process's own exit, never something printed, so a command can't fake its end. "Always" holds
   for the exact command run from the same folder with the same carried variables; when either
   changes, it asks again. Everything else ADR 0130 sets for the shell still holds: every command
   asks first, output past 4 MiB is dropped, the deadline is 60 s by default and 110 s at most,
   and output is untrusted (as is every file a command makes).
6. **Windows keeps the one-shot shell for now.** It has no bot terminal yet; its `shell` runs each
   command on its own, as before.

### Taking over and handing back

7. **The person takes over; the bot pauses.** `driver` is `bot` or `person`. Taking over pauses
   the bot's open turn at its next safe point, through the same pause Spade uses for an update,
   applied to this conversation only. A streaming model step finishes and is stored, nothing new
   starts, and tools cut off are answered "may have run". Messages sent meanwhile are stored and
   wait. Stop still works. While the person has the computer, the bot shows "Paused while you
   have the computer", never idle. The person gets the controls only once none of the bot's
   work runs: its terminal command is gone and ace says its calls there have ended (the
   computer shows `stopping` until then).
8. **The person drives.** They type into the terminal (refused with `409` while the bot drives,
   so the person's input never mixes into a bot's command), use the browser and screen through
   ace, and change files through the app.
9. **Handing back resumes the bot with a note.** Spade stores `computer_handed_back` with its
   summary of what the person did: how long they had it, whether they used the terminal, the
   workspace files that are new, changed or removed since the take-over, and whether ace said
   they used the browser or the screen. Nothing the person types is kept, stored or shown to
   the model: their input goes to their shell and nowhere else. File names and addresses are chosen by whoever made the
   file or page, so they go apart from Spade's words as data, and a note with them counts as
   untrusted content like a fetched page. Then the paused turn carries on, or the waiting messages
   are answered. The daemon hands the browser and screen back first and says what the person did
   there (addresses visited, tabs opened and closed, whether the screen was used); the note
   names addresses only, never page titles. The model reads the note as Spade's, wrapped in
   `<computer_handed_back from="spade">`, so it never takes the person's work for its own.
   The note is stored before the bot is released, so a crash can only repeat it, never lose it.
10. **The person's turn survives a restart.** While the person drives,
   `<data folder>/computer/<bot>.json` holds the take-over: its conversation, the workspace as it
   was, and the surfaces used so far. A Spade that starts with it keeps the bot
   paused and its messages waiting until the hand-back. The daemon keeps its driver in memory
   only, so Spade tells it again every few seconds while the person drives, and while ace has
   not confirmed a hand-back. Changes of driver go to ace one at a time per bot, ending at the
   latest asked for, so a take-over ace answers late can't undo a hand-back.

### Safety

11. **The bot's rules don't change.** Approvals and ADR 0130's trust allowlist apply to
    everything the bot does on its computer, before and after a take-over.
12. **What the person writes is theirs.** A file the person writes or uploads through the app is
    recorded as trusted, and a file they move keeps its trust at its new path. Files changed from
    the terminal are named in the note but stay untrusted: Spade can't tell the person's command
    from a process the bot left running in the background.
13. **Confined like every file operation.** The person's writes, uploads, folders and moves go
    through the workspace's directory handle (cap-std), refusing absolute paths, `..` and links
    that lead out. A move is one rename that refuses a taken target (`renameat2` /
    `renamex_np`), so it never replaces something already there. Windows, which has no such
    rename, checks and then renames.

## Consequences

- The app can show the bot's work as it happens and hand the person the controls without a
  message round trip.
- A bot's commands now keep their folder and exported variables between commands. Nothing a
  command starts outlives it, except on macOS a process that detached and was reparented away
  before the end.
- The note costs a few hundred tokens per hand-back, and the model loses nothing it needs to
  carry on.
- ace reports each bot's browser and screen to Spade (`PUT .../computer/surfaces/{kind}`), and
  Spade reads them back from ace at start (`spade.computer.get`). While ace is away, those
  surfaces show live only while the bot calls their tools.
- While the person drives, ace refuses the bot's browser and screen calls (`person_driving`).
  Spade tells the model the call didn't run and isn't to be retried.

The API is in [spade/docs/computer.md](../../spade/docs/computer.md).
