# Workspaces and skills a bot writes

Date: 2026-11-12, the skill store 2026-11-14, file tools and `python` 2026-11-23 (ADR 0220). As built for
[ADR 0130](../../docs/adr/0130-spade-skills-and-workspace.md) and points 1–7 of
[ADR 0151](../../docs/adr/0151-spade-skills-and-plugins.md), in `spade-server` (`workspace/`,
`learning/`, `skill_store/`, `api/workspace.rs`, `api/skills.rs`). Extends
[harness.md](harness.md) and [agents.md](agents.md).

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

Files are opened with `O_NONBLOCK` and read only when the opened handle is a regular file; a
folder, FIFO, socket or device is refused (`422` from the API), so a read, search, edit or download
never waits on one. Searches skip anything but regular files without opening it.

### Tools

| Tool               | Arguments                                                                   | Risk  | What it does                                                                                                     |
| ------------------ | --------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------- |
| `workspace_list`   | `path?`                                                                     | read  | One folder: folders first (`name/`), files with their size, links marked; 500 entries max                        |
| `workspace_read`   | `path, offset?, limit?`                                                     | read  | Numbered lines `offset..offset+limit` (default 1 and 400, at most 2,000) of a text file; an image or a document  |
| `workspace_search` | `text, path?, ignore_case?, regex?, glob?`                                  | read  | `path:line: text` for lines holding `text` (or matching it, with `regex`); links not followed, 200 matches max   |
| `workspace_find`   | `pattern, path?`                                                            | read  | `N files:` then `path (size bytes)` for each file whose path fits the glob, by path; links not followed, 500 max |
| `workspace_write`  | `path, content`                                                             | write | Writes the whole file (2 MiB max), creating folders                                                              |
| `workspace_edit`   | `path, old, new, replace_all?` or `path, edits: [{old, new, replace_all?}]` | write | Replaces `old` at its one place (every place with `replace_all`); several edits apply in order, all or none      |
| `shell`            | `command, timeout_s?, outside_sandbox?`                                     | write | Runs the command in the folder (see below)                                                                       |
| `python`           | `code` or `path, args?`, `timeout_s?`                                       | write | Runs Python in the folder, in the bot's sandbox only (see below)                                                 |

Text files are read up to 4 MiB; anything not UTF-8 is reported as binary.

**Reading images and documents.** `workspace_read` looks at a file's first bytes. A PNG, JPEG,
GIF or WebP (up to 3.75 MB) comes back as the image, beside the line `path: a PNG image, N
bytes.`; a model that doesn't see images reads `[workspace_read returned an image (image/png),
but this model cannot see images.]` instead, as for any tool's image. A PDF, Word or Excel file
(up to 32 MiB) goes through the document reader ([media.md](media.md)): it is stored like a file
the person attached and the model reads its `<document …>` view, reading on with
`document_read`. Anything else is read as text as before. The trust rule is the same for all of
them: trusted only when the bytes are the ones Spade's file tools recorded.

**Searching.** `text` is found as written (`ignore_case` lower-cases both sides) or, with
`regex: true`, read as a regular expression by the `regex` crate, which runs in time linear in
the text whatever the pattern; a pattern over 1,000 characters, nested past 64 or compiling past
1 MiB is refused in words. `glob` keeps the search to files whose path fits it. A pattern without
`/` (`*.csv`) is matched against the file's name in any folder, one with `/` (`data/*.csv`,
`src/**/*.rs`) against its path from the top; `*` and `?` stay within a name, `**` crosses
folders and `[a-z]`, `[!a-z]` match one character. A glob is compiled to a regular expression, so
it matches in linear time whatever its wildcards. A search or find opens the start folder and
every folder under it one name at a time without following a link, opens each file the same way and checks it is a regular file on the opened handle (never by its name first), visits 20,000 entries (files
and folders) at most, checks its 5-second deadline at every entry and every 4,096 lines it
scans, reads no more of a file than its 2 MiB cap whatever the file has grown to, and says when
it stopped early.

**Edits.** Each edit must find its `old`: once, or any number of times with `replace_all`. In a
batch each applies to what the ones before it left; when one can't, the call fails with `Edit 2
of 3 ("old text…"): why. Nothing was changed.` and the file is left as it was. Each edit's
resulting size is worked out first, with checked arithmetic, and one past 2 MiB is refused before
anything is built. The answer says how many places changed. Trust is recorded as for a single edit.

### The shell

On macOS and Linux the bot's commands now run in its persistent terminal, which the person can
watch and take over; see [computer.md](computer.md). What follows is the one-shot shell, which
Windows still uses, and the rules both share.

- `/bin/sh -c <command>` on macOS and Linux, `%SystemRoot%\System32\cmd.exe /D /S /C <command>`
  on Windows (`workspace/shell.rs`, the one platform branch).
- Contained: on macOS and Linux its own process group (`process_group(0)`), killed with
  `kill -KILL -<group>`; on Windows a job object with kill-on-close, which the command is assigned
  to as it starts (anything it starts in the moment before that is not held). Everything is
  killed when the deadline passes (default 60 s; the model may give any longer `timeout_s`) and
  again when the run ends however it ends (finished, timed out, or the call
  dropped by Stop or the harness), and the output readers are aborted with it.
- A command still running after the turn's 30 s foreground window keeps running as a background
  job: the call answers with its job id and the output arrives as a `<job_result>` (ADR 0158).
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

**Sandboxed commands.** Where Spade's OS sandbox holds files and network (macOS today), a
command runs in the bot's sandbox and isn't reviewed unless the classifier finds something that
could leave through an allowed path; see [security.md](security.md). What follows holds where
there is no sandbox.

**Asking.** Every shell call is a write and asks, even one that only reads; reading without
asking goes through the file tools. Answering with `always` allows that exact command (the same
string) for the bot from then on, and nothing else: `Tool::always_scope` gives the shell's scope
as the command, and the gate looks for an `approval_answered` with `always` whose
`approval_requested` had the same tool and scope in the conversation's events. A turn that read
untrusted content asks for every command, `always` or not; since shell output is untrusted, that
includes a second command in the same turn.

### Python

`python` runs Python 3 for the bot: `code`, or a script in the workspace (`path`, with `args`),
in the workspace folder, with a fixed set of packages. It runs only where Spade's sandbox holds
the bot's commands (macOS and Linux with the sandbox, and not for a bot set to run outside it);
anywhere else it answers `Not run: the python tool runs only inside Spade's sandbox, which isn't
holding your commands here. Run python3 with shell instead.` before anything is written. Windows
says it isn't available there yet. ADR 0220.

**One environment per machine, built by Spade.** The packages are pandas, numpy, matplotlib,
openpyxl, python-docx, pypdf and requests, with everything they need, as `spade/config/python-lock.txt`
pins them: exact versions and every wheel's hash, from `https://pypi.org/simple`. Nothing else can
be installed, and nothing is resolved at runtime. Spade builds the environment itself, on the
host, never in a bot's sandbox, the first time any bot runs `python` (never at start), into
`<data folder>/workspace/.python/shared/`:

| In `shared/`                  | What it is                                                        |
| ----------------------------- | ----------------------------------------------------------------- |
| `control/`                    | `run.sh` and `boot.py`                                            |
| `environments/<name>/`        | One environment, read-only once built, named by the lock it holds |
| `current.json`                | Which environment bots run with now                               |
| `pythons/`, `cache/`, `home/` | uv's downloaded CPython, its cache, its home                      |
| `locks/`, `leases/`           | The lock installed, and the files runs hold their environment by  |

Every bot's runs read `control/`, `environments/` and `pythons/` (the sandbox reopens them
read-only, `Facts.runtime`, inside Spade's data only); nothing in any sandbox writes there.

**What Spade runs to build it.** Before a build, Spade looks once for uv and the Pythons in those
folders and vets each one it finds (`python::vetting`): resolved fully, the program and every
folder above it (and above the name it was found by) must be owned by root or the user Spade runs
as, never writable by others (a root-owned sticky folder such as `/tmp` passes), and writable by
their group only when that group is root's or, on macOS, `admin` (whose members can become root
anyway, as Homebrew's folders are); and neither the program nor the folder it was found in may
lie inside any bot's workspace or any folder any bot may write (every write grant of every bot).
A program that fails is never run, and the result says which and why (`Spade didn't use
/usr/local/bin/uv: …`). uv never picks a Python by itself: it gets its pinned uv-managed CPython
or the vetted Python by path. The environment is named from this one look (with uv, or the
standard library), and the result names the programs that made it (`Made with uv …, uv's own
CPython 3.12.`).

**Building.** Under a machine-wide lock (`leases/build.lock`), with an environment that has only
the system folders on `PATH`, a home of its own, uv's configuration discovery off
(`UV_NO_CONFIG`, `--no-config`), files copied (`UV_LINK_MODE=copy`) and the machine's proxy and
certificate variables passed on:

1. **With uv** (looked for in `/usr/local/bin`, `/opt/homebrew/bin`, `/usr/bin`, `/bin`): `uv venv`
   with a pinned uv-managed CPython 3.12 (downloaded once into `pythons/`), else a Python 3.10 or
   newer on the machine; uv's own start-up hook (`_virtualenv.pth`) is removed; then `uv pip
install --no-deps --require-hashes --only-binary :all: --index-url https://pypi.org/simple -r
<the lock>`. Spade then checks what got installed: every package locked at its installed
   version, every one of the seven there, and no `.pth` start-up file among them (a lock entry
   that installs one is refused).
2. **Without uv:** `python3 -I -S -m venv --without-pip` (no `site`, so nothing of that Python's
   own packages runs as Spade) from the first vetted Python 3.10 or newer in
   those folders: the standard library only, said plainly (`with its standard library only: uv
isn't on this machine, and Spade installs packages only with uv…`). Spade doesn't fetch uv:
   one command installs it, and a fetched binary would be one more pinned, hash-checked download
   per platform to keep.
3. **Neither:** `Python could not be set up: No Python 3.10 or newer was found on this machine
(looked for uv and python3 in …). The person can install one, for example with Homebrew:
brew install python.`

The environment is built in `environments/.building-<random>`, made read-only, and moved to its
name with one rename; only then is `current.json` replaced (one rename), and only then are other
environments swept. A failure at any step deletes only the folder being built and leaves
`current.json` naming a whole environment. It is built again only when Spade's lock changes (a
new name), or uv comes or goes. The first call waits for the build and its result starts with
`[Set up Python for Spade's bots: 3.12.14, with pandas, numpy, matplotlib, openpyxl,
python-docx, pypdf, requests.]`.

**Leases.** A run takes a shared lock on `leases/<environment>.lock` before it starts and holds
it until its script has ended, however long that takes (a background job included). In the bot's
terminal the lease goes to the terminal's supervisor with the command, so a call that is stopped
or dropped first still holds the environment until everything the script started has ended. An
environment other than the current one is deleted only when Spade can take that lock
exclusively, so never under a running script; one still held is kept until a later sweep.

**Staged scripts.** When the gate classes a call, Spade reads its script (the code, or the
workspace file opened through real folders only, 2 MiB at most) and stages it as
`.python/bots/<bot id>/scripts/<sha256>.py`, written by Spade through no-follow handles; the
bot's runs read it and nothing in any sandbox writes it. A workspace script's whole text goes to
the reviewer (`Classed.shown`) on any reviewed route, and a call too long for the reviewer goes to
the person. Staging is required: a call whose staged copy couldn't be written, is missing at
launch or no longer holds its bytes is refused (`Not run: Spade runs only the copy of the script
it took when the call was checked…`), and the workspace is never read again. What a reviewer or the person
is shown is read back from the staged copy itself, and the scope they are asked with names that
same copy's hashes, never a copy staged again (with none still held the scope names nothing and
the run refuses); a call they allowed runs only if those are the bytes
staged when it runs, so a copy staged again (after a restart) from a changed file isn't run on
their answer (`Not run: the script (or a module it imports) isn't the one the person allowed…`).

**Workspace modules.** With the script Spade stages the modules it may import: each `.py` under
the script's folder (the workspace for code, `.spade` left out, 500 at most) that Spade's file
tools wrote from a clean prompt (a trust record whose hash its bytes still match), staged as read
then, listed in a staged JSON. `boot.py` adds a finder at the END of `sys.meta_path`, after the
standard library and the installed packages: a listed module is imported from its staged copy;
any other module in the workspace raises `ImportError: <name> is a module in your workspace, but
Spade imports only modules its file tools wrote from a clean prompt…`. The workspace is never on
`sys.path`, so no workspace file can stand in for a standard, installed or missing module.
`__file__` and `argv[0]` are the script's path in the workspace (`<code>` for code), the working
folder is the workspace, and no bytecode is written.

**One runner.** The call is classed as sandboxed like a contained command and goes through
`shell`'s runner (`shell_tool::cleared` and `run_cleared`): the gate's launch is taken once, and
the script runs in the bot's terminal on macOS and Linux (the person sees `/bin/sh
<shared>/control/run.sh <environment> <workspace> <script> <modules> <name> <args>…`, every word
absolute or quoted, so no name reads as an option) or the one-shot shell, with the same timeout
(60 s unless `timeout_s`), the 30-second foreground window and background job, output caps,
large-output file, `command_ran` and blocked hint. `run.sh` starts the environment's Python with
`-I -S -u boot.py`: no `PYTHON*` variable, no user site, no `site` at all (so no `.pth` file and no
`sitecustomize` runs at start), and `boot.py` adds the environment's installed packages to
`sys.path` itself. `MPLBACKEND=Agg` (charts are saved to files, nothing opens a window), with
matplotlib's settings in the run's `TMPDIR`.

**What it answers.** What the set-up said, if it ran, then the command's result as `shell` gives
it (exit code, stdout, `[stderr]`), then `Files it made or changed:` with each new or changed
file and its size and each removed one. Changes are told from each regular file's size,
modification time to the nanosecond and inode, before and after (links never followed, Spade's
`.spade` folder left out, 50 named at most); a same-size rewrite in place within the file
system's timestamp precision is not seen, and a workspace past 20,000 entries says some may be
missing. Each PNG, JPEG, GIF or WebP among them (up to 3.75 MB, 8 at most), opened without
following a link and checked to be a file once opened, is attached to the result for the model
and shown in the chat (a `shared` event). Its output is untrusted like any command's, and nothing
it writes is trusted.

### Trust

Trust is an allowlist. A bot's trusted files are recorded in
`<data folder>/workspace/.trust/<bot id>.json`, outside its folder, as path → SHA-256 of the content
Spade wrote there. The engine passes each call what the turn has read (`TurnFacts.untrusted`, from
`spade_core::context::untrusted_sources`), and:

- "Clean" here means the prompt the call was made from shows nothing untrusted:
  `TurnFacts.untrusted` comes from `spade_core::context::untrusted_in_view`, every untrusted event
  since the last `context_compacted` (`keep_from`), this turn's or an earlier one's, plus the
  summary when it was drawn from untrusted content. "Save that result" a turn after reading a
  page is therefore not clean. Notes and proposals take their `source` from the same view.
- `workspace_write` from a clean prompt records the path and hash; otherwise it removes the
  path. `workspace_edit` records the new hash only from a clean prompt and only when the file was
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

## Spade's skill store

Every Spade keeps its own skills (`skill_store/`), so its bots have skills with ace away and on
Spade Cloud. Each skill is a folder, `<data folder>/skills/<id>/`, holding `SKILL.md` and the
skill's other files, and a row in Spade's SQLite (`skills`: id, origin, name, description,
manual, body, SKILL.md hash, the other files as `[{path, size, hash, executable}]`, source,
updated). Origins:

| Origin   | Id                    | What it is                                                                              |
| -------- | --------------------- | --------------------------------------------------------------------------------------- |
| `ace`    | the library's `skl_…` | A copy of a skill in ace's library; `source` is its scope; read only                    |
| `spade`  | `sks_` + 20 hex       | Written in Spade while ace was away, from a bot's saved proposal                        |
| `plugin` | `plg_` + 20 hex       | A plugin's skill or command ([plugins.md](plugins.md)); offered only to bots allowed it |
| `market` | `skm_` + 20 hex       | Installed from ace's marketplace (ADR 0168); `source` is its entry name; read only      |

A folder is always replaced whole: written as `.stage-<id>-<random>`, the old one moved to
`.old-<id>-<random>`, the new one renamed into place, the old one removed. On start, a
moved-aside folder whose skill has no folder is put back and everything else staged or aside is
removed.

**Mirroring ace's library.** While Spade is connected to ace, a background task lists the
library with `subscribe: true` (once per socket) and copies each skill whose SKILL.md hash
differs from its copy: `read` for SKILL.md, then `files` and each file by path; a file whose
bytes don't match the listed hash fails that copy and the old one stays. On a new connection it
also compares every skill's file list with its copy, since a file can change without SKILL.md;
the daemon's change notices only follow SKILL.md. It runs again on each `skills.changed`, when
the socket ends or Spade connects to another daemon, and every ten minutes. A skill the library
no longer lists is dropped, unless the listing was stale. Plugin-scope entries are skipped (their
files are the plugin's). With ace away the last copies are used, and nothing says so.

**Copying market skills.** The person installs a `spade-skill` entry in ace's marketplace; the
daemon pins it. While Spade is connected, a second background task sends `marketplace.request
{operation: {op: "spadeSkills"}}` for the installed skills and their pinned hashes, and for each
new or changed hash `{op: "spadeSkillFiles", name}` for the file list (`SKILL.md` among them),
then `{op: "spadeSkillFiles", name, path}` for each file (base64 in `content`). A file whose
bytes don't match its listed hash, or past ADR 0103's limits, fails that copy and the old one
stays; otherwise the copy is replaced whole. A skill the daemon no longer lists is dropped. It
runs on start, on each `marketplace.changed` the daemon pushes, when the socket ends or Spade
connects to another daemon, right after a bot is made from a recipe, and every ten minutes. With
ace away, or a daemon whose marketplace can't answer, the last copies stay and nothing says so.
Market skills serve every bot and are never edited in Spade.

**Several skills with one name** are offered once: ace's personal copy, then ace's other copies,
then a `spade` skill, then a market skill, then a plugin's.

**Saving goes to ace when ace is there.** A new skill (a saved proposal) is created in ace's
library while connected, then mirrored at once; with ace away (always on Cloud) it is written to
the store as a `spade` skill, refused when the store already has the name. An edit of a `spade`
skill stays in the store, checked against its SKILL.md hash. An edit of an ace skill goes to ace;
with ace away it is refused as unavailable and the proposal stays open. Spade never sends a
`spade` skill to ace on its own.

**Add to ace's library** (Settings › Spade › Skills, `POST /v1/skills/{id}/add-to-ace`) creates
a `spade` skill in ace's library for every agent, marks the row `added:<library id>`, and the
next mirror (run at once) drops the row once the library lists that id. A retry after a lost
answer only waits for that drop and never creates twice.

## Skills to and from the shared standard

ADR 0202 §1. A skill folder made to the [Agent Skills specification](https://agentskills.io/specification)
imports as a `spade` skill, and any skill the store keeps a folder for exports as one.
`@ace/marketplace`'s `skill-md.ts` is the one reader: the market's skill check, `ace bot check` and
both commands use it.

**What is checked.** `SKILL.md` starts with YAML front matter. `name`: 1–64 lower-case letters
and digits in runs joined by single hyphens, and the folder's own name. `description`: text, not
empty, at most 1,024 characters. `license`: text. `compatibility`: text, at most 500 characters,
shown and never a reason to refuse. `metadata`: keys with text values; `spade.` keys are Spade's
own. `allowed-tools`: tool names separated by spaces. Each problem names its line. Any other field
is kept and listed as "Not used by this Spade", never refused. The market's other skill checks
(secrets, limits, the scanner on market uploads) run as before.

**`allowed-tools` grants nothing.** The review and `ace bot check` say "It asks to run Bash and
Read without asking. Spade still decides each call." Spade never reads the field: it stays in
`SKILL.md`, and the gate reads every call a skill's instructions lead to as it reads any other.

**Import.** `ace spade skill import FROM [--git] [--path FOLDER] [--replace]` reads a folder, or
one folder of a git repository through the plugin fetcher (shallow bare fetch, isolated config,
no hooks, links and submodules refused), leaves hidden files out, and runs the checks above. Then
it sends `POST /v1/skills/import {name, description, manual, skill_md, files: [{path, executable,
content}], source, replace}`, with content as base64. Spade holds the name and description rules
again, a front matter start, `SKILL.md` at most 256 KiB, plain non-hidden paths inside the folder
listed once each, and ADR 0103's limits (512 files, 4 MiB each, 16 MiB together). It keeps
`SKILL.md` and every file byte for byte as a `spade` skill (`sks_` + 20 hex of the name), its
source `imported:<path or address>`. A name the store already holds is refused (409), unless
`replace` is set and the skill there was written in Spade. Imports are the person's alone
(ADR 0178 §12.5), like installs.

**Export.** `ace spade skill export SKILL [DIR]` reads `GET /v1/skills/{id}/export` (`{name,
origin, source, files}`, any origin but `plugin`, whose skills export with their plugin) and
writes `DIR/<name>/`, which must not exist. `SKILL.md` keeps the specification's fields and its
body as they were. Fields the specification doesn't define, which its validator refuses at the
top level, move under `metadata` as `spade.field.<name>` with their value as JSON. Two keys are
added: `spade.version` (`1`, the version of this mapping) and `spade.source` (`spade`, the import's
address, `market:<entry>` or `ace:<scope>`). Nothing else is added. The export is checked against
the validator's rules before anything is written.

**Round trip.** An import of an exported folder lifts `spade.field.*` back to the top level and
takes `spade.version` and `spade.source` out, so it stores the skill that was exported. A folder
with none of those keys is stored byte for byte.

## Loading a skill brings its files

`skill_load` answers with SKILL.md, then, when the skill has other files, the folder they are in
and each path with its size (and "runnable" for an executable one). The files are written into
the bot's workspace at `skills/<name>/` when the skill is loaded: kept as they are when the
folder holds exactly the skill's files (nothing else: no other file, link or empty folder), each
with the same content and still trusted; otherwise the folder is deleted, with the trust records
of everything in it, and written again, so nothing of an older version stays or stays trusted.
A skill with no other files has no folder: loading it removes one an older version left. Each file is written through the workspace
handle like any write, then made read only (`0444`, or `0555` for an executable one) through a
handle that does not follow links; on Windows files stay writable, since a read-only file there
could not be replaced or deleted when the skill changes. Each is recorded in the trust record
with its hash (`Trust::record_installed`): the person installed the skill, so `workspace_read`
of one answers trusted. A command that rewrites one changes its hash, and it reads as untrusted
like any other file a command changed. Scripts run with `shell`, under the same gate as any
command.

## Ranking

`spade_core::skills` is pure. `skill_search` scores each word of the query (two letters or
more) that begins a word of a skill's name (4), description (2) or body (1), the first place it
is found, times `ln(1 + skills / (1 + skills having the word))`, so a rare word counts more.
Equal scores (in thousandths) go to the skill the calling bot last marked helpful, then the one
it loaded more, then by name. Each bot's use is kept in `skill_uses` (loads, helpful), counted by
`skill_load` and set by `skill_feedback`, and deleted with the bot. The index frozen into a
conversation lists the 40 skills its bot loaded most, then by name.

## Skills a bot writes

Offered by every Spade, beside `skill_search` and `skill_load`, whether or not ace is there;
proposals are saved through the skill store above. Neither tool changes anything outside Spade,
so neither asks.

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
state. **Saving** records an `attempt` in the proposal file, then saves through the skill store:
with ace there it sends `skills.request` to the daemon over the socket Spade already reads skills
on: `create` with scope personal, every agent (`claude`, `codex`, `opencode`, `cursor`, `pi`) and
`manual: false`, or `edit` with `expectedHash` from `base` and its `manual`. Neither is resent
after a dropped socket. With ace away a new skill is written to the store instead. A refusal
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

| `GET /skills` | | `{"skills": [{"id", "name", "description", "origin", "manual", "files", "updated_at", "written_by", "used_by"}], "ace": bool}`; `ace` is whether Spade is connected now. `written_by`: the bots whose saved proposals wrote or changed a skill of that name; `used_by`: the bots that have loaded it (`skill_load`); bot ids, sorted. A bot's Library lists the skills naming it |
| `POST /skills/{id}/add-to-ace` | | `200 {"skill_id"}`; `404` unknown; `422` not a `spade` skill; `409` ace has the name; `503` ace away |
| `GET /skills/{id}/files` | | `200 {"name", "files": [{"path", "executable", "content"}]}`, `SKILL.md` first, content as base64, for publishing to ace's marketplace. Every folder and file is opened without following a link; SKILL.md is at most 1 MB, each file 4 MB, all of them 16 MB and 512 files. `404` unknown; `422` not a `spade` skill, a link, a special file or past a limit |

Workspace errors: `404` for an unknown agent or a missing path, `400` for a path that is absolute,
uses `..` or leads outside, `422` for a folder where a file is wanted and similar. The app places
a proposal's bubble after the reply that holds the call `call_id`.
