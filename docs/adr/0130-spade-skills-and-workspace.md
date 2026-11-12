# 0130: Spade's bots write skills and each has a workspace

Status: accepted. Date: 2026-11-12. Decided by: the owner (2026-11-12: make Spade complete, so its
bots learn from the work they do and each has a place to work). Builds on
[ADR 0103](0103-skill-library.md) (the skill library), [ADR 0123](0123-spade-runs-as-its-own-service.md)
(Spade's service and data folder), [ADR 0126](0126-spade-agents.md) and
[ADR 0127](0127-spade-main-bot-and-chat.md) (bots, one conversation each, shown as a chat).

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
   relative to the folder; absolute paths, `..` and anything that resolves outside it after
   following symlinks are refused.
6. **A shell in the folder.** `shell {command, timeout_s?}` runs the command in the bot's folder
   with `sh -c` on macOS and Linux and `cmd /C` on Windows (one platform branch, in one module). It
   runs in its own process group (on Windows, its process tree), is killed with the whole group
   on timeout (default 60 s, at most 110 s, inside the harness's 120 s tool limit), and its output
   is capped. The
   environment is built, not inherited: `PATH`, `HOME` (the workspace), `LANG`, `TERM=dumb` and the
   platform's few required variables. Spade's token, endpoint keys and the ace grant never reach it.
7. **Risk.** File reads, lists and searches are reads. Writes and edits are writes. A shell command
   is a write, so it asks, unless it is in a short built-in allowlist of read-only commands (`ls`,
   `cat`, `head`, `tail`, `wc`, `grep`, `find` without `-exec`/`-delete`, `pwd`, `echo`, `date`,
   `stat`, `du`, `diff`, `tree`, `git status|log|diff|show`, without the options that write)
   with no shell syntax that could do more (redirection, `;`, `&`, `|`, backticks, `$`) and no
   argument that reaches outside the folder (absolute, `~`, `..`), or the person answered an
   earlier one with "Always" for that bot. On Windows every command asks. A turn that read
   untrusted output asks for every write and every command not on the allowlist, as before
   (harness.md). Workspace files and shell output count as trusted: the folder holds only what
   the bot wrote or ran with the person's leave.
8. **Large output becomes a file.** A result over 16,000 characters (a shell's output, a search) is
   written to `.spade/outputs/<call>.txt` in the workspace and the model gets its head and tail and
   the path, which it can page through with `workspace_read`.

### In the app

9. **Files.** The bot's menu gains **Files**: a cardless page that lists the bot's workspace
   (folders first), opens text files read-only, downloads a file, and deletes a file or folder after
   the person confirms. The chat itself shows nothing of the file and shell tools (ADR 0127); a
   shell command that asks arrives as the usual approval bubble, with **Always** beside Allow and
   Deny.

## Consequences

- Bots get better with use, and what they learn is reviewed by the person before any agent reads
  it.
- A bot can do real work on files and with commands without the person's machine being open to
  it: one folder, a clean environment, and the person asked for anything but plain reads.
- The allowlist is short on purpose; most commands ask until the person allows them always.
- Text a bot saved from the web in one turn reads as trusted in a later one. The person approved
  the write that saved it; marking file reads untrusted would make every later write ask.
- The workspace is not a sandbox: an allowed command runs with the person's user rights. Process
  isolation is left for later.
- Proposals and notes are files in Spade's data folder, not database rows, so no migration is
  needed.

## Tests

- Paths with `..`, absolute paths and a symlink pointing out of the workspace are refused.
- A shell command over its timeout is killed with its whole process group.
- The shell's environment carries none of Spade's secrets.
- An allowlisted command runs without asking; any other command asks.
- Output over the limit is stored as a file and the model gets the path.
- A saved proposal reaches the skill library (a fake daemon receives `create`/`edit`); a discarded
  one does not.
