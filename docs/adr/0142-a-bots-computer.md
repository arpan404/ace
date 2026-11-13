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

### The terminal

3. **One shell per bot, kept between commands.** An interactive `/bin/sh` in a pseudo-terminal,
   started in the bot's workspace with the same clean environment as the one-shot shell of
   ADR 0130 (none of Spade's secrets, system folders on `PATH`, `HOME` the workspace) plus a
   terminal type. A folder change or a variable set by one command is there for the next. The
   last 2 MiB of output is kept for viewers. The shell is ended after 6 hours unused, unless the
   person has the computer; it is also ended when the bot is deleted and when Spade stops, and
   everything in its session goes with it. The next use starts a new one.
4. **The bot's `shell` tool types into that terminal.** Each command is written to a file in
   Spade's own scratch folder and sourced, with stdin from `/dev/null`, between two marker
   sequences that terminals don't display. What lies between the markers is the command's
   output, and the end marker carries its exit status. Everything ADR 0130 sets for the shell
   still holds: every command asks first, "always" allows that exact command only, output past
   4 MiB is dropped, the deadline is 60 s by default and 110 s at most, and output is untrusted
   (as is every file a command makes). A command past its deadline gets Ctrl-C, then its job is
   killed, and the shell stays. When a program other than the shell holds the terminal's
   foreground (the person left one open), the bot's command is refused rather than typed into
   that program.
5. **Windows keeps the one-shot shell for now.** It has no bot terminal yet; its `shell` runs each
   command on its own, as before.

### Taking over and handing back

6. **The person takes over; the bot pauses.** `driver` is `bot` or `person`. Taking over pauses
   the bot's open turn at its next safe point, through the same pause Spade uses for an update,
   applied to this conversation only. A streaming model step finishes and is stored, nothing new
   starts, and tools cut off are answered "may have run". Messages sent meanwhile are stored and
   wait. Stop still works. While the person has the computer, the bot shows "Paused while you
   have the computer", never idle.
7. **The person drives.** They type into the terminal (refused with `409` while the bot drives,
   so the person's input never mixes into a bot's command), use the browser and screen through
   ace, and change files through the app.
8. **Handing back resumes the bot with a note.** Spade stores `computer_handed_back` with its
   summary of what the person did: the lines they entered at the shell's prompt (as typed; never
   keystrokes, and never a line typed into a running program such as a password prompt), the
   workspace files that are new, changed or removed since the take-over, and whether ace said
   they used the browser or the screen. Then the paused turn carries on, or the waiting messages
   are answered. The model reads the note as Spade's, wrapped in
   `<computer_handed_back from="spade">`, so it never takes the person's commands for its own.
   The note is stored before the bot is released, so a crash can only repeat it, never lose it.
9. **The person's turn survives a restart.** While the person drives,
   `<data folder>/computer/<bot>.json` holds the take-over: its conversation, the workspace as it
   was, and the lines entered and surfaces used so far. A Spade that starts with it keeps the bot
   paused and its messages waiting until the hand-back.

### Safety

10. **The bot's rules don't change.** Approvals and ADR 0130's trust allowlist apply to
    everything the bot does on its computer, before and after a take-over.
11. **What the person writes is theirs.** A file the person writes or uploads through the app is
    recorded as trusted, and a file they move keeps its trust at its new path. Files changed from
    the terminal are named in the note but stay untrusted: Spade can't tell the person's command
    from a process the bot left running in the background.
12. **Confined like every file operation.** The person's writes, uploads, folders and moves go
    through the workspace's directory handle (cap-std), refusing absolute paths, `..` and links
    that lead out. A move never replaces something already there.

## Consequences

- The app can show the bot's work as it happens and hand the person the controls without a
  message round trip.
- A bot's shell now keeps state between commands. Background processes a command starts stay
  until the terminal ends; before, they were killed when the command ended.
- The note costs a few hundred tokens per hand-back, and the model loses nothing it needs to
  carry on.
- ace has to report each bot's browser and screen to Spade (`PUT .../computer/surfaces/{kind}`).
  Until it does, those surfaces show live only while the bot calls their tools.

The API is in [spade/docs/computer.md](../../spade/docs/computer.md).
