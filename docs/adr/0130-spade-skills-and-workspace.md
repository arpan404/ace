# 0130: Spade's bots write skills and each has a workspace

Status: accepted. Date: 2026-11-12. Decided by: the owner (2026-11-12: make Spade complete, so its
bots learn from the work they do and each has a place to work). Builds on
[ADR 0103](0103-skill-library.md) (the skill library), [ADR 0123](0123-spade-runs-as-its-own-service.md)
(Spade's service and data folder), [ADR 0126](0126-spade-agents.md) and
[ADR 0127](0127-spade-main-bot-and-chat.md) (bots, one conversation each, shown as a chat). Revised
the same day after review, by the owner's decisions: no read-only command allowlist, "always"
per exact command, and trust in files as an allowlist (a second review replaced marking untrusted
files, which could miss some, with it).

## Context

Spade's bots can find and load skills from ace's library (`skill_search`, `skill_load`) but never
add to it, so what a bot works out in a long task, or what the person corrects, is lost once the
conversation is compacted. And a bot has nowhere of its own to keep files or run a command: its
only effects are web reads, ace's tools and messages to other bots.

## Decision

### Skills a bot writes

1. **A bot proposes; the person decides.** After a task of several steps, or after the person
   corrects it, a bot may call `skill_propose {name, description, body, why}`. A name no skill in
   the library has is a new skill; the name of an editable personal skill is an edit of it, and
   the proposal keeps the skill's id, hash, description and body as they were. Proposing changes
   nothing outside Spade, so it runs without asking. Proposals are kept in Spade's data folder; a
   new proposal for a name replaces the bot's open one for that name. At most 20 are open per bot.
2. **A proposal is a bubble.** The conversation shows it as the bot's bubble: one sentence, the
   skill collapsed (expandable to its description and full text; an edit shows the lines that
   change), and **Save** and **Discard** as text buttons. It sits after the reply that made it.
   An answered proposal keeps its bubble, with "Saved" or "Discarded" in place of the buttons.
3. **Saving goes through ace's library.** Save sends `skills.request` `create` (personal scope,
   linked for every agent the library knows) or `edit` with the hash the proposal was based on,
   over the daemon socket Spade already uses for reading skills, authenticated by the daemon's
   local token. No new daemon request is needed. A skill that changed since the proposal is
   refused (`409`) and the proposal stays open; the person can ask the bot again. Saved skills are
   ordinary library skills: every bot and every ace agent can use them.
4. **Bots keep notes on skills they used.** `skill_feedback {name, verdict: helpful | outdated,
note?}` stores the bot's latest verdict on a skill. `skill_load` shows the bot its own notes
   with the skill, so an outdated one leads to a proposed edit rather than being followed again.

### A workspace per bot

5. **One folder per bot, on its machine.** `<Spade's data folder>/workspace/<bot id>/`, created on
   first use and deleted with the bot. Tools: `workspace_list`, `workspace_read` (a window of lines),
   `workspace_search`, `workspace_write` and `workspace_edit` (one exact replacement). Every path is
   relative to the folder; absolute paths, `~` and `..` are refused. Every file operation goes
   through the folder's opened directory handle, one component at a time relative to it (`cap-std`),
   so no path, symlink or folder swapped mid-operation reaches outside. Writes go to a new file
   beside the target and are renamed over it, never truncated in place, and a file with more than
   one hard link is never written. The same holds for kept outputs (9).
6. **A shell in the folder.** `shell {command, timeout_s?}` runs the command in the bot's folder
   with `/bin/sh -c` on macOS and Linux and `cmd.exe /C` on Windows (one platform branch, in one
   module). On macOS and Linux it runs in its own process group; on Windows in a job object set to
   kill everything in it when closed. Either way everything the command started is killed on
   timeout (default 60 s, at most 110 s, inside the harness's 120 s tool limit) and again when the
   run ends, and the output readers end with it; what was read before a lingering process held a
   pipe is kept. Output is capped. The environment is built, not inherited: `HOME` (the
   workspace), `LANG`, `TERM=dumb`, the platform's few required variables, and a `PATH` of system
   folders only (never Spade's own, `.`, an empty entry or anything in the workspace; on Windows,
   cmd.exe is also told not to look in the current folder first). Spade's token, endpoint keys and
   the ace grant never reach it.
7. **Risk.** File reads, lists and searches are reads; writes and edits are writes. Every shell
   command asks, even one that only reads, unless the person answered that exact command (the same
   string, for that bot) with **Always allow this command**; "always" never covers a command's
   shape or every command. Reading without asking goes through the file tools only.
8. **Trust is an allowlist.** A turn that read untrusted content (the web, another bot, any shell
   output, an untrusted workspace entry, a skill note written in such a turn) asks for every write,
   "always" or not, as before (harness.md). In the workspace:
   - A file is trusted only if Spade's own file tools (`workspace_write`, `workspace_edit` of a
     trusted file) wrote it in a turn that had read nothing untrusted, and its content still has
     the hash recorded then. The record (path and hash) is kept outside the bot's folder.
   - Everything else is untrusted: whatever a command made or changed, anything moved, copied or
     brought in, files Spade never wrote, kept outputs, and every folder and link itself; so is a
     file reached through a link. Nothing is ever marked untrusted, so nothing can be missed: no
     timestamps, no scan limits, nothing to do when a command is stopped.
   - A listing is trusted only if every entry it shows is a trusted file; a search only if every
     file it quotes is. Reading or listing anything untrusted marks that result untrusted
     (`tool_finished.untrusted`), which taints the turn.
   - A skill note written in a tainted turn taints the turn that loads the skill; a proposal made in
     one records the source and the app shows it beside Save ("Written after reading …").
9. **Large output becomes a file.** A result over 16,000 characters (a shell's output, a search) is
   written to `.spade/outputs/<call>.txt` in the workspace and the model gets its head and tail and
   the path, which it can page through with `workspace_read`.
10. **A Save is reconciled.** Before writing, the proposal records the attempt. If the library's
    answer never comes, the proposal stays open with the attempt; the next Save or Discard first
    looks in the library for the skill with the proposal's content (or the edit's base hash) and
    settles from that instead of writing twice. If the library holds something else under that name
    (or the edited skill is gone), Save answers that Spade can't confirm the earlier save, and
    Discard still works. One answer to a proposal runs at a time, claimed before its state is read.

### In the app

11. **Files.** The bot's menu gains **Files**: a cardless page that lists the bot's workspace
    (folders first), opens text files read-only, downloads a file, and deletes a file or folder
    after the person confirms (the confirmation names its path). Moving to another machine, bot
    or folder closes what was open. The chat itself shows nothing of the file and shell tools
    (ADR 0127); a shell command that asks arrives as the usual approval bubble, showing the exact
    command, with **Allow**, **Always allow this command** and **Deny**. A refused or unanswered
    Save or Discard reads the proposals again, so one already answered shows as it is.

## Consequences

- Bots get better with use, and what they learn is reviewed by the person before any agent reads
  it.
- A bot can do real work on files and with commands without the person's machine being open to
  it: one folder, a clean environment, and the person asked before any command they have not
  allowed by its exact text.
- Shell output taints its turn, so a second command in the same turn asks even when allowed
  always; "always" saves a question at the start of later turns. Files a command made, and every
  folder, are untrusted, so listing a folder that holds one, or reading what a command made,
  taints the turn and later writes in it ask. Work that leans on commands asks more.
- The workspace is not a sandbox: an allowed command runs with the person's user rights and can
  reach the whole machine. Process isolation is left for later.
- Proposals, notes and trust records are files in Spade's data folder, not database rows, so no
  migration is needed.

## Tests

- Paths with `..`, absolute paths and a symlink pointing out of the workspace are refused.
- A shell command over its timeout is killed with its whole process group.
- The shell's environment carries none of Spade's secrets.
- Every command asks; "always" allows only that exact command, in later turns.
- A program planted in the workspace is never found by name; `PATH` holds no `.`, empty entry or
  workspace folder.
- A file with another hard link is never written; nothing lands outside through a link.
- A file written after reading a page taints the turn that reads it; so do a file a command made,
  a folder moved in from elsewhere (however old its files), a link's name and a file read through
  it, every file of a 6,000-file tree a command made, and a file a stopped command wrote. A
  listing of only trusted files stays trusted.
- After a lost Save, when the library's copy changed, Save can't confirm and Discard works.
- Output read before a lingering process held a pipe is kept.
- Output over the limit is stored as a file and the model gets the path.
- A saved proposal reaches the skill library (a fake daemon receives `create`/`edit`); a discarded
  one does not; a Save whose answer was lost is found in the library and not written twice; a
  proposal made after reading a page names it.
