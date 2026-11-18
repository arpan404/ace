# 0181: An opt-in project marker, as a hint only

Date: 2026-11-17. Status: accepted. Decided by: the owner, after a technical review
([docs/plans/project-identity-review.md](../plans/project-identity-review.md) §7). Builds on
[ADR 0180](0180-logical-project-identity.md). **Makes one exception to
[ADR 0120](0120-project-git-repositories.md)**, which keeps per-project choices "never in the
user's repository or Git config".

## Context

Logical project identity (ADR 0180) lives in each daemon. A fresh clone on a new machine has
no way to say "I am that project" until the person links it by hand. A small file in the
repository can carry the id to every clone. But anyone can copy a file, read-only and upstream
repositories can't carry one, and reuse during a transfer merges `.env` and other ignored files
into a checkout, so a file must never decide anything on its own.

## Decision

### The exception, and its limits

ace writes `.ace/project.json` into a project's folder only when the person chooses **Share
identity with clones** in Edit project. ace never commits, stages or pushes it; committing it is
the person's choice. Nothing else of a project's is ever written into the repository, and every
other ADR 0120 rule stands.

### Contents

`{ "version": 1, "id": "<uuid>", "name"?: "<name>" }` and nothing else: no paths, hosts,
machine names or credentials. A subfolder project's marker lives in that subfolder.

### Reading it as untrusted data (ADR 0125)

- Opened through the project folder's held descriptor (ADR 0063): `.ace` must be a directory
  and `project.json` a regular file, both opened without following symbolic links and without
  blocking, so a symlink, FIFO or device reads as absent.
- At most 4 KiB, read within a timeout (500 ms); larger, slower, unreadable, not JSON or not
  the schema: absent.
- Read only when the person adds or inspects a folder, or lazily while suggestions are asked
  for. Never when the daemon opens.

### What a marker does

- **Adding a folder** whose marker names a logical project the person's machines know shows a
  link confirmation naming that project and its checkouts, with Link as the default. Linking
  records the registration's source as `marker`. One confirmation per registration.
- **A fork**: when the folder's remotes are not those of the known checkouts, the prompt says
  "fork of …" and offers **Keep linked** or **New project**. New project keeps the new
  registration's own identity; the original's registrations are unchanged.
- **Suggestions** list registrations whose marker names the asked identity, marked as such,
  among the remote suggestions. Nothing links without confirmation, and the confirmation of one
  found only by its marker says that anyone can copy a marker. Linking it joins that
  registration alone, recorded as `marker`: nothing is merged on the strength of a file.
- **Never a transfer landing**: a registration whose identity came from a marker is never where
  a transfer lands by identity (ADR 0180), and a marker is never read for a landing.
- **Writing** goes through the held descriptor with an exclusive create. A marker that already
  names the same logical project (its id or one merged into it here) is left alone. One naming
  another project (`marker_conflict`), or a file there that isn't a marker (`marker_unreadable`),
  is replaced only after the person confirms what is there (`replace`), never silently.
- Read-only folders and repositories work entirely without a marker; a write that fails says so
  and changes nothing else.

## Limits

The timeout bounds reading the file. Opening the folder and the file are local system calls the
timeout can't interrupt, so a project on a hung network mount can still hold the read; this is
the same exposure every read of a project folder has, and suggestions open at most one page of
folders per request.

## Rejected

- **Auto-committing the marker.** A commit in the person's repository is theirs to make.
- **Linking on a marker alone.** A copied marker in an unrelated repository would then merge
  projects and pull ignored files into the wrong checkout on the next transfer.
- **Reading markers at daemon open.** History-sized work at open is banned (ADR 0170).

## Verification

`apps/daemon/src/project-marker.process.test.ts`: a symlink, a FIFO, a file over 4 KiB, a
symlinked `.ace` and malformed or wrong-schema JSON all read as absent without hanging; writing
creates exactly the schema, never follows a symlink, leaves a same-id marker alone and refuses
another id without `replace`. Web tests: a copied marker produces only a confirmation, never a
link on its own; a fork's New project leaves the original unchanged.
