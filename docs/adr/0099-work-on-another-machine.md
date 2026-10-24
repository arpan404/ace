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
target is refused with `machine_not_linked`; the app offers Settings › Machines to link them.

### Authority

These are the person's actions, not an agent's, so the target's `remote.agentAccess` does not
apply. The target requires the calling device to hold both `operate` and `projects` (ADR 0063:
remote admin does not imply projects). A device without them gets `machine_forbidden` with a
next step: link again with "Projects" allowed. No agent tool can start a transfer.

### How the code travels

The sending machine chooses, in order:

1. **remote**: the checkout is a Git repository with an `origin` the target can clone. If the
   target already has a project whose origin is the same repository (URLs compared after
   normalising scheme, `git@host:` form, trailing `.git` and case of the host), it reuses it;
   otherwise it clones origin itself with its own Git credentials. The sender then sends a
   bundle holding only the commits origin doesn't have (`git bundle create` with the
   origin-tracking refs as negative refs), which may be empty.
2. **bundle**: a Git repository with no remote, or one the target couldn't clone. The bundle
   holds every local branch and tag. The target clones from it and removes the bundle remote.
3. **archive**: a folder that isn't a Git repository. A tar of the whole folder, symlinks kept as
   links and never followed out of the folder, sockets and devices skipped.

Uncommitted changes (method 1 and 2, when `includeChanges`) are captured without touching the
sender's checkout or index: a temporary index file, `git add -A` into it, `write-tree` and
`commit-tree` on top of HEAD, put in the bundle under `refs/ace/transfer/<id>`. The target
applies that commit's diff against HEAD to its checkout and leaves it uncommitted, then deletes
the ref. Ignored files are not sent; that is what `.gitignore` asks for.

### Where it lands

- A project the target already has (same origin): the branch is fetched from the bundle. If the
  project's own checkout is clean and on that branch, or the transfer is a thread continuation in
  worktree mode, a new worktree is made for the branch, so the target's existing checkout is never
  disturbed. A branch name already used there with different commits gets a `-from-<machine>`
  suffix.
- Otherwise a new project in `parent`, or the target's default clone folder, named after the
  source project (`-2`, `-3`… when taken), registered the way `workspace.clone` registers.

### Continuing a thread

Refused while the source thread's tree is still working, waiting on the person, or has live
terminals, with the same checks as `thread.move`. The source captures the portable history
handoff it already builds for account and provider moves (`@ace/handoff`), bounded and with
declared loss, and sends it with the import. The target starts a thread in the landed project
with the same mode (local or worktree), title "<title> (from <machine>)", the same provider and
model when installed there or else its default, and the handoff as history. It doesn't start a
turn; the person sends the next message there. Attachments are not carried in this slice; the
handoff says so.

### Reliability

- The sender keeps a durable transfer row (SQLite) with phase, method, byte offset and digest.
  Bundles and archives are written once to the sender's data directory and sent in 4 MiB chunks,
  each acknowledged by offset; a restart or a lost connection resumes from the target's
  acknowledged offset. The target keeps the incoming file and row keyed by transfer id, so a
  repeated begin, chunk or commit is idempotent.
- The target verifies the SHA-256 of the whole file before importing. A failed or cancelled
  import never registers a project, and removes only folders it created.
- Cancel works in every phase before `starting`; after that the thread exists and is the result.
- Finished transfer files are deleted on both machines; rows are kept 24 hours for the list.
- Transfers above 20 GiB are refused before sending, with the size in the message.

### UI

- Thread menu: "Continue on…", project menu: "Open on…", each listing linked machines, with
  offline or not-allowed machines shown with the reason instead of hidden.
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
mismatch, cancel, a device without `projects`, a missing fleet link, and a thread continuation
whose new thread has the handoff and the provider fallback. UI tests run against the fake daemon.
