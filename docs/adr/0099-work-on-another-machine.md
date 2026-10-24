# 0099: Work on another machine

Status: accepted. Date: 2026-10-23.

## Context

A person runs ace on several machines (ADR 0078): a laptop, a desktop, a build server. The app
already connects to all of them at once, Add project can clone a URL onto any of them, and
agents can delegate to them. What is missing is carrying work you already have to another
machine: "I started this on my laptop, I want to keep going on the desktop", or "I want this
project on the build server too". Today that means pushing a WIP branch by hand, cloning on the
other machine, and re-explaining the task to a new agent.

## Decision

Two actions, both started from the app on the machine that has the work:

- **Open on <machine>** (project menu, `workspace.transfer`): the project appears on the other
  machine, on the same branch, with uncommitted changes as uncommitted changes there.
- **Continue on <machine>** (thread menu, `thread.continueOn`): the same for the thread's
  project and checkout, then a new thread there that starts from this thread's history. This
  thread records where the work went (`ThreadDetails.continuedOn`); the new one records where it
  came from (`continuedFrom`). Both stay ordinary threads; nothing is deleted.

The wire is in `packages/protocol/src/transfers.ts`.

### Who sends

The sending daemon owns the transfer and sends straight to the target over its fleet link
(ADR 0078's paired-device TLS listener, the same pinned key and device token). Bytes go machine
to machine over LAN or Tailscale, never through the client, so a phone on cellular can start a
multi-gigabyte move, and closing the window doesn't stop it. A machine with no fleet link to the
target is refused with `machine_not_linked`; the app offers Settings › Fleet to link them.

### Authority

The person starts transfers from the app, and agents start them with the `transfer` tool (below).
The target requires the calling device to hold both `operate` and `projects` (ADR 0063: remote
admin does not imply projects). A device without them gets `machine_forbidden` with a next step:
link again with "Projects" allowed. The target's `remote.agentAccess` does not apply to
transfers; they are governed by the setting below.

### Agents

Agents carry work with one ace tool, `transfer`:
`{ machine, project?, thread?, includeChanges?, includeIgnored? }`
where `machine` is a name from `machines`, and either the calling thread's own project
(default), a named project, or the calling thread itself (`thread: "self"`, which continues it
there). It returns at once with the transfer id; the result is delivered like a background task,
so the agent's tree is never done while a transfer it started is still running. `machines` shows
whether each machine accepts transfers.

`remote.agentTransfers` (boolean, default on), shown in Settings › Fleet as "Agents can move
projects and threads to other machines", is checked by the sending machine before an agent's
transfer starts. Off refuses with `transfers_off` and a next step. The person's own transfers
from the app are not affected. A read-only thread can't start one (ADR 0078's caller ceiling).

### How the code travels

The sending machine chooses, in order:

1. **remote**: the checkout is a Git repository with an `origin` the target can clone. If the
   target already has a project whose origin is the same repository (URLs compared after
   normalising scheme, `git@host:` form, trailing `.git` and case of the host), it reuses it;
   otherwise it clones origin itself with its own Git credentials. This transfer clone never
   prompts: Git Credential Manager is non-interactive, SSH uses the configured `core.sshCommand`
   in batch mode, and askpass is disabled. A three-minute deadline bounds the attempt;
   authentication failures and timeouts fall back to a full bundle. Cancellation stops the clone.
   The sender then sends a bundle holding only the commits origin doesn't have (`git bundle create`
   with the origin-tracking refs as negative refs), which may be empty.
2. **bundle**: a Git repository with no remote, or one the target couldn't clone. The bundle
   holds every local branch and tag, plus the sender's last-known origin-tracking refs when it
   has an origin. The target imports it without configuring a remote to the bundle file, then
   restores `origin` to the source's fetch URL. The current branch tracks its matching origin
   branch when the sender had that tracking ref. This uses local information only, without a
   network request. Remote metadata travels with both methods and survives fallback; URLs with
   embedded credentials are rejected using the clone URL validation.
3. **archive**: a folder that isn't a Git repository. A tar of the whole folder, symlinks kept as
   links and never followed out of the folder, sockets and devices skipped.

Uncommitted changes (method 1 and 2, when `includeChanges`) are captured without touching the
sender's checkout or index: a temporary index file, `git add -A` into it, `write-tree` and
`commit-tree` on top of HEAD, put in the bundle under `refs/ace/transfer/<id>`. The target
applies that commit's diff against HEAD to its checkout and leaves it uncommitted, then deletes
the ref.

### Ignored files

Files Git ignores are usually the ones a checkout needs to run but must never commit: `.env`,
local config, editor settings. Leaving them behind made a moved project fail on its first run.
So the git methods (1 and 2) send them too, unless the transfer says not to.

- `remote.transferIgnoredFiles` (boolean, default on), shown in Settings › Fleet as "Bring
  ignored files" with one line: "Local files Git ignores, such as .env and local config, go too.
  Dependency folders are rebuilt there instead." It is the sending machine's default.
  `workspace.transfer`, `thread.continueOn` and the agents' `transfer` tool take an optional
  `includeIgnored` that overrides it; the options step has a "Bring ignored files" switch beside
  "Bring uncommitted changes", starting at the setting.
- What goes: the paths `git ls-files --others --ignored --exclude-standard --directory` lists, a
  wholly ignored folder once, packed with the folder archive (`@ace/files` `packFiles`: links kept
  and never leaving the folder, sockets and devices skipped, modes kept). Folders that are
  platform-specific or rebuilt stay, wherever they sit: `node_modules`, `.venv`, `venv`,
  `__pycache__`, `.pnpm-store`, `.yarn/cache`, `.gradle`, `.next`, `.turbo`, `.cache`, `target`.
  So do nested Git repositories (a folder holding `.git`). The list is one pure module,
  `apps/daemon/src/transfers/ignored-files.ts`. The archive method (3) already copies the whole
  folder and is unchanged.
- How it travels: a second payload in the same transfer, uploaded after the code to
  `PUT /v1/transfers/chunk?…&part=ignored`, resumed from the target's `ignoredOffset` like the
  first. `commit` carries its size, SHA-256 and file count as `ignored`. A target answers with
  `ignoredOffset` only when it takes ignored files, and the sender sends none to one that
  doesn't, so older machines keep working. The 20 GiB cap counts both payloads.
- Securely:
  - The bytes take only the pinned-TLS fleet link, never the client or a relay.
  - Both payloads wait as mode 0600 files in the daemon's data directory (`transfers/`, mode 0700) and are deleted after import, on cancel, on failure, and at startup when no unsettled
    transfer owns them.
  - Names and contents never reach logs, `transfer.progress`, transfer rows, errors or the
    handoff. The sender's `Transfer.ignoredFiles` holds only a file count and a byte total; the
    result holds only `ignoredSkipped`. Failures say "The files Git ignores couldn't be read"
    without naming one.
  - The target checks the archive's SHA-256 before anything is written; a mismatch fails the
    transfer with `transfer_corrupt`.
  - The target places them once the checkout and its uncommitted changes are there (in the new
    thread's worktree when it has one), with `mergeArchive`: every write goes through
    descriptors opened from the landed folder without following links; an existing file or
    link is never replaced (a reused project keeps its own `.env`; the done line says how many
    were kept, "kept its own copy of 1 ignored file"); a member whose parent there is not a
    folder is skipped; nothing is ever written into a `.git` folder, whatever the sender sent.
    Modes are kept, so a 0600 file stays 0600 (set-id bits and group or other write bits are
    dropped, as for any unpacked archive).

### Where it lands

- A project the target already has (same origin): the branch is fetched from the bundle. If the
  project's own checkout is clean and on that branch, it is fast-forwarded and the changes are
  applied there. Otherwise the target's checkout is never disturbed: the branch gets its own linked
  worktree in a folder beside the project (`<project>-<branch>`), or, for a thread continuation,
  the new thread runs in worktree mode from that branch. A branch name already used there at a
  different commit gets a `-from-<machine>` suffix (`-2`, `-3`… when that is taken too).
- Otherwise a new project in `parent`, or else the folder of the target's newest project, or else
  its home, always inside its allowed project roots; named after the source project (`-2`, `-3`…
  when taken), registered through `workspace.add` or `workspace.clone`.
- method `remote` clones origin on the target when the import starts. If that clone fails, or the
  bundle needs commits the reused project doesn't have, the target asks for a full bundle and
  the transfer carries on as `bundle`.

### Continuing a thread

Refused while the source thread's tree is still working, waiting on the person, or has live
terminals, with the same checks as `thread.move`. The source captures the portable history
handoff it already builds for account and provider moves (`@ace/handoff`), bounded and with
declared loss, and sends it with the import. The target starts a thread in the landed project
with the same mode (local or worktree), title "<title> (from <machine>)", the same provider and
model when installed there or else its default, and the handoff as history. It doesn't start a
turn; the person sends the next message there. Attachments are not carried in this slice; the
handoff says so.

The handoff's excerpts are all the new agent can read of the source thread: `handoff_read` pages
only threads on its own machine, so the new thread's context says the rest stayed on the source
machine. An agent continuing its own thread (`thread: "self"`) is the live work the busy check
would refuse; for it the check is skipped and the handoff is captured when the upload is done.

### Reliability

- The sender keeps a durable transfer row (SQLite) with phase, method, byte offset and digest.
  Bundles and archives are written once to the sender's data directory and sent in 4 MiB chunks,
  each acknowledged by offset; a restart or a lost connection resumes from the target's
  acknowledged offset. The target keeps the incoming file and row keyed by transfer id, so a
  repeated begin, chunk or commit is idempotent.
- The wire between the machines: `POST /v1/transfers` with `probe`, `begin`, `status`, `commit`
  and `cancel` (`packages/protocol/src/machine-transfers.ts`), and
  `PUT /v1/transfers/chunk?transfer=<id>&offset=<n>` for the pieces. `probe` needs only a paired
  device, so Settings › Fleet and `machines` show which links take transfers even when that
  machine keeps agents out.
- The target verifies the SHA-256 of the whole file before importing; a damaged file fails the
  transfer with `transfer_corrupt`. A failed or cancelled import leaves no project registered
  (one it registered on the way is removed again) and removes only folders it created.
- Cancel works in every phase before `starting`; after that the thread exists and is the result.
- Finished transfer files are deleted on both machines; rows are kept 24 hours for the list.
- Transfers above 20 GiB are refused before sending, with the size in the message.

### UI

- Settings › Fleet: the `remote.agentTransfers` and `remote.transferIgnoredFiles` switches.
- Thread menu: "Continue on…", project menu: "Open on…", each listing linked machines, with
  offline or not-allowed machines shown with the reason instead of hidden. The options step has
  "Bring uncommitted changes" and "Bring ignored files".
- A single sentence strip while it runs ("Sending to Studio · 312 MB of 1.2 GB" with Cancel),
  and "Continued on Studio" with Open when done. Open switches to that machine's thread or
  project when the app is connected to it.
- The source thread shows "Continued on Studio · Open"; the new one shows "Continued from
  MacBook".

## Rejected

- **Client-relayed bytes.** Sending through the app doubles the traffic and dies with the
  window or the phone's connection.
- **Push to origin only.** Needs a remote and push rights, and leaves WIP commits on a shared
  remote. Origin is still used to avoid sending what it already has.
- **Syncing every thread to every machine.** Needs the deferred accounts backend; out of scope.

## Follow-ups

- iOS and Android menus (the wire is the same).
- Carrying thread attachments, and moving back (today: continue again in the other direction).
- Routing over the self-hosted relay when machines can't reach each other directly.

## Verification

Two real daemons in temp homes, paired over TLS as `ace remote add` stores them, with real Git
repositories and a local bare repository standing in for origin. Tests cover each method,
uncommitted changes including deletions and binary files, reuse of an existing project,
branch-name collision, resume after a dropped connection and after a sender restart, digest
mismatch, cancel, a device without `projects`, a missing fleet link, an agent's transfer delivered as a background result and refused with the setting off, and a thread continuation
whose new thread has the handoff and the provider fallback. For ignored files: `.env` and ignored
local config arrive with their modes while `node_modules` does not; none go with the setting off
or `includeIgnored: false`; a reused project keeps its `.env`; no ignored file's name appears in
pushes, rows or logs; both payloads are gone after completion, after cancel and after a restart.
UI tests run against the fake daemon.
