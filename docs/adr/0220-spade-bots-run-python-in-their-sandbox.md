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

1. **Search reads patterns.** `workspace_search` takes `regex` (the `regex` crate: linear time in
   the text whatever the pattern; patterns over 1,000 characters, nested past 64 or compiling past
   1 MiB are refused) and `glob` (a file pattern: by name without `/`, by path with it, `**`
   across folders). Its output stays `path:line: text`, 200 matches; it stops after 5 seconds.
2. **`workspace_find`** (`pattern`, `path?`) lists files whose path fits a glob, with sizes, by
   path, 500 at most, links not followed. A read: it runs without asking, and its answer is
   trusted only when every file it names is.
3. **Edits change every place or several at once.** `workspace_edit` takes `replace_all`, and
   `edits: [{old, new, replace_all?}]` applied in order to what the ones before left, all or none;
   a failure names the edit (`Edit 2 of 3 ("…")`) and changes nothing.
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
7. **A per-bot environment, made on first use.** Spade writes a small launcher before each run.
   It makes `.spade/python/venv` the first time: with `uv`, a pinned uv-managed CPython 3.12 when
   one can be had, else a Python 3.10 or newer on the machine; without `uv`, `python3 -m venv`
   from the newest Homebrew or system Python 3.10 or newer; with none, a plain error saying what
   it looked for. It then installs pandas, numpy, matplotlib, openpyxl, python-docx, pypdf and
   requests until they are in. Nothing is made at Spade's start. Installing reaches the network
   through the sandbox's proxy like any command, so the person's Network permission decides.
   matplotlib uses the Agg backend.
8. **A run says what it made.** The result names each file the run made, changed or removed (a
   snapshot before and after, `.spade` left out), and the images among them are given to the
   model and shown in the chat. Its output and its files are untrusted, like a command's.
9. **The system prompt says to use it.** "How you work" tells the bot to write and run a short
   Python script for counting, data, files, conversions or charts instead of working them out, and
   to check its output.

## Consequences

- Bots answer data and file questions from code they ran, and the person sees the step as "Ran a
  Python script" with the script's path or first line, and the files it made.
- The first `python` call for a bot takes longer (a CPython download and the packages, about 15
  seconds on a fast link) and uses a few hundred MB in its workspace; later calls start at once.
  A refused network leaves the bot with a bare Python until the person allows the package hosts.
- A bot whose commands run outside the sandbox, and Windows, have no `python` yet; they use
  `shell`.
- Searches and finds skip `.spade/python`, so the environment never crowds them out.

## Tests

- Regex and glob search find the right lines and stop at 200; a broken pattern is refused.
- Find lists the fitting files with sizes and skips links.
- `replace_all` changes every place; a batch whose second edit fails changes nothing.
- Reading an image gives an image-reading model the image and another model a note; a Word file
  reads as its text.
- A file Spade's tools didn't write stays untrusted through find, search and a batch edit.
- With a real interpreter in the macOS sandbox: a script that writes a CSV and a PNG names both
  and attaches the PNG; the environment is made once and reused; a long script becomes a
  background job. With no Python the run says so; without the sandbox it is refused before
  anything is written.
