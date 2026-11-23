# 0220: Spade bots search, find, edit and read files fully, and run Python in their sandbox

Status: accepted. Date: 2026-11-23. Decided by: the owner (2026-11-23: "we are missing many tools
like file edit, view, search, etc and also way to run python so agent can write scripts in python
to do their work for better result", and "do those tool optimisations too"). Extends
[ADR 0130](0130-spade-skills-and-workspace.md) (the workspace and its tools). Builds on
[ADR 0158](0158-spade-no-fixed-step-or-time-limits.md) (background jobs),
[ADR 0167](0167-spade-security-boundaries.md) (the sandbox), [ADR 0171](0171-spade-decides-on-effects.md)
(where a call runs decides it) and [ADR 0170](0170-daemon-never-blocks-on-history-sized-work.md).

## Context

A bot's file tools could list a folder, read text, find a literal substring, write a whole file
and replace one exact place. Anything else (counting rows, converting a spreadsheet, drawing a
chart, finding files by name, renaming a word through a file) went through `shell`, where the bot
had to know which programs the machine had, or was worked out in the model's head, where it is
often wrong. Models do better work when they can write a short script and read its output.

## Decision

1. **Search reads patterns, within a budget.** `workspace_search` takes `regex` (the `regex`
   crate: linear time in the text whatever the pattern; patterns over 1,000 characters, nested
   past 64 or compiling past 1 MiB are refused) and `glob` (a file pattern: by name without `/`,
   by path with it, `**` across folders, compiled to a regular expression so it too matches in
   linear time). Its output stays `path:line: text`, 200 matches. A search or find opens every
   folder without following a link (the start's too), visits 20,000 entries at most, checks its
   5-second deadline at every entry and while it scans, and never reads past its 2 MiB cap.
2. **`workspace_find`** (`pattern`, `path?`) lists files whose path fits a glob, with sizes, by
   path, 500 at most, links not followed. A read: it runs without asking, and its answer is
   trusted only when every file it names is.
3. **Edits change every place or several at once.** `workspace_edit` takes `replace_all`, and
   `edits: [{old, new, replace_all?}]` applied in order to what the ones before left, all or none;
   a failure names the edit (`Edit 2 of 3 ("…")`) and changes nothing. An edit whose result
   would pass the 2 MiB write limit is refused before it is built.
4. **Reads show images and read documents.** `workspace_read` decides by a file's first bytes: a
   PNG, JPEG, GIF or WebP up to 3.75 MB is returned as the image (a model that can't see images is
   told so, as for any tool's image); a PDF, Word or Excel file goes through Spade's document
   reader and reads as an attached document does, with `document_read` to read on; anything else
   is text, as before.
5. **The trust rules don't change.** Every new path keeps ADR 0130's allowlist: a file is trusted
   only when its bytes are the ones Spade's file tools wrote from a clean prompt, an edit keeps a
   file trusted only if it was, and a result that shows anything untrusted (a name, a line, an
   image) makes the rest of the turn untrusted.
6. **`python` runs Python in the bot's sandbox, through `shell`'s runner.** `code` or `path` with
   `args`, `timeout_s`. It is classed, launched, timed out, moved to the background after 30
   seconds and described exactly as a contained `shell` command, in the bot's terminal where
   there is one: one runner, not a second. It runs only where the sandbox holds the bot's
   commands; elsewhere (no sandbox, a bot set to run outside it, Windows for now) it refuses
   before writing anything and points to `shell`. Outside the sandbox a command's start is bound
   to what the classifier read in it (ADR 0171, amendment 5), and a script Spade writes at run time
   can't be bound that way, so this tool doesn't go there.
7. **The Python is Spade's, not the workspace's.** Each bot's environment, launcher, set-up
   script and staged scripts live in a runtime folder outside its workspace
   (`<data>/workspace/.python/<bot>/`). The sandbox reopens it read-only for every run of the bot
   (a new `Facts.runtime`, accepted only inside Spade's data); only Spade's set-up, a separate
   contained run of Spade's fixed script (`Kind::PythonSetup`), may write it. The set-up works
   from the runtime folder, never the workspace, starts Python with `-I`, turns off uv's and pip's
   configuration discovery, and installs a locked set of pinned packages (pandas, numpy,
   matplotlib, openpyxl, python-docx, pypdf, requests and everything they need), binary wheels
   only, from PyPI's index and no other. A run starts the environment's Python with `-I`. So
   nothing the bot writes, and nothing a page it read steers it into writing, changes the
   interpreter, its packages or how they were installed. The environment is made the first time
   the tool runs, never at start: with `uv`, a pinned uv-managed CPython 3.12 when one can be had,
   else a Python 3.10 or newer on the machine; without `uv`, `python3 -I -m venv` from the newest
   Homebrew or system Python 3.10 or newer; with none, a plain error saying what it looked for.
   Installing reaches the network through the sandbox's proxy, so the person's Network permission
   decides. matplotlib uses the Agg backend.
8. **What runs is what was classed.** When the gate classes a call, Spade stages its script (the
   code, or the workspace file read through real folders only) by its content's hash in the
   runtime. A workspace script's whole text goes to the reviewer on a reviewed route, and one too
   long for the reviewer goes to the person. The run uses the staged copy, by an absolute path, so
   a later change to the workspace file, a swap while the call waits, or a name starting with `-`
   changes nothing. The script runs on its own: modules beside it in the workspace aren't on its
   path.
9. **A run says what it made.** The result names each regular file the run made, changed or
   removed, told apart by size, nanosecond modification time and inode (links never followed,
   `.spade` left out, and it says when the workspace is too large to see whole); the images among
   them, opened without following a link, are given to the model and shown in the chat. Its output
   and its files are untrusted, like a command's.
10. **The system prompt says to use it.** "How you work" tells the bot to write and run a short
    Python script for counting, data, files, conversions or charts instead of working them out, and
    to check its output.

## Consequences

- Bots answer data and file questions from code they ran, and the person sees the step as "Ran a
  Python script" with the script's path or first line, and the files it made.
- The first `python` call for a bot takes longer (a CPython download and the packages, about 15
  seconds on a fast link) and uses a few hundred MB in its runtime folder; later calls start at
  once. A refused network leaves the bot with a bare Python until the person allows the package
  hosts.
- The bot can't add packages to the environment the tool runs; a package outside the locked set
  needs a change to the set (or a venv of its own made with `shell`). Pins are by version, not by
  hash, and the lock has to be refreshed by hand.
- A bot whose commands run outside the sandbox, and Windows, have no `python` yet; they use
  `shell`.

## Tests

- Regex and glob search find the right lines and stop at 200; a broken pattern is refused.
- Find lists the fitting files with sizes and skips links.
- `replace_all` changes every place; a batch whose second edit fails changes nothing.
- Reading an image gives an image-reading model the image and another model a note; a Word file
  reads as its text.
- A file Spade's tools didn't write stays untrusted through find, search and a batch edit.
- Searches stop at their entry budget in a tree of folders alone, and never enter a linked
  folder, the start included; a glob of many wildcards matches in linear time; an edit past the
  write limit is refused.
- With a real interpreter in the macOS sandbox: a script that writes a CSV and a PNG names both
  and attaches the PNG (one-shot and in the terminal); the environment is set up once from a local
  wheel and its package imports later with no reinstall; the `venv` path sets up despite a
  shadowing `venv.py` and broken pip and uv configuration in the workspace; the bot's own command
  can read the runtime and not change it; a script named `-c` runs as a script; the script classed
  (and shown in full) is the script that runs after the workspace file is swapped; a long script
  becomes a background job. With no Python the run says so; without the sandbox it is refused
  before anything is written.
