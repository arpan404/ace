# Review: cross-machine project identity

Reviewer: Opus 5.5 on Omarchy. Checkout `aa660bfe7`. Technical review only, no code changed.

## Verdict: REVISE. The revised plan below is approved for implementation.

The core of the plan is sound and stays as proposed:

- A logical project sits above machine-local registrations, which sit above threads, which sit
  above provider sessions.
- Identity never comes from provider metadata.
- Threads stay bound to their registration (`workspace_id`).
- There are no silent merges, and migration is conservative.

Three parts are unsafe or contradict existing decisions as written:

1. **The committed marker as the main mechanism.** ADR 0120 says per-project choices are "Never
   in the user's repository or Git config". Read-only and upstream repos can't carry a marker.
   Anyone can copy a marker, so it can't count as authority.
2. **Transfer wire compatibility.** The fleet transfer messages are strict (see below).
3. **No rule for how daemons that don't share a store agree on an ID.**

## Where the code differs from the problem statement

1. **There are two copy mappings, not one.**
   - In the client: `ace.home.copiedProjects` in each client's local storage
     (`apps/web/src/features/home/new-thread/copied-projects.ts`, capped at 100). Each browser or
     device has its own, and iOS has none.
   - In the daemon: `transfer_incoming_landed`, keyed by sender host, source workspace, device and
     git (`apps/daemon/src/transfers/incoming-rows.ts:100`).
2. **Origin matching has a cap and an arbitrary tie-break.** `sameOriginProject` only reads the
   first 64 projects, in id order, and returns the lowest id
   (`apps/daemon/src/project-origin.ts:15`). With more than 64 projects a match is silently
   missed. With several checkouts, or monorepo subfolders sharing one origin, it picks the
   oldest one.
3. **Matching uses the `origin` remote only** (`packages/git/src/transfer-refs.ts:9`). It
   ignores the configured source-control remote (`apps/daemon/src/workspace-runtime.ts:225`) and
   ADR 0120's other repositories. A fork with `origin`=fork and `upstream`=main never matches the
   upstream checkout.
4. **Subfolder projects collide.** Subfolder registration is allowed (ADR 0063), but a subfolder
   reads the same origin as its repo root.
5. **`TransferBegin` and `TransferCommit` are `z.strictObject`**
   (`packages/protocol/src/machine-transfers.ts:37,71`). An old target rejects any new field.
   Identity must be negotiated the way `ignoredOffset` already is.
6. **iOS has no cross-machine matching.** `apps/ios/bridge/project-list.ts` only reads each
   machine's own list.
7. **An in-repo `.ace/` folder already exists as something ace reads:** `.ace/launch.json`
   (`packages/preview/src/launch-config.ts`), `.ace` command roots
   (`packages/commands/src/roots.ts:41`), and `packages/project-picker` excludes it. So
   `.ace/project.json` fits the namespace. But writing it into the repo needs a new ADR that
   explicitly makes an exception to ADR 0120.

## Revised architecture (approved)

### 1. Identity is minted by the daemon and lives in the daemon

- `ProjectIdentity` is a UUID, minted lazily: on the first link, on a transfer landing, or on a
  new add, clone or create.
- New side tables:
  - `workspace_identity(workspace_id PK → workspaces, identity_id, source ∈
created|linked|transfer|marker, linked_at)`
  - `identity_alias(from_id PK, to_id, at)`
- A registration with no row is its own singleton, which clients key as `hostId/workspaceId`.
- No backfill, and no Git or marker reads when the daemon opens (ADR 0170). Creating the empty
  tables is fine.
- Ids come from an injected id generator, and timestamps from the injected clock.

### 2. Only the person's own daemons are an authority

An identity can be set in four ways:

- created locally;
- an explicit link (`projects` authority, ADR 0063, with a durable receipt per ADR 0057; recheck
  authority after awaited work);
- a transfer from a paired device;
- a marker that the person confirmed.

Remotes and markers only ever produce suggestions. A marker is untrusted repository data and
never grants anything across machines.

### 3. Grouping across machines happens in the client, using aliases

- `Project` gains an optional `identity: { id, aliases (max 32), source }`. Zod's default
  stripping means old clients ignore it.
- Clients group registrations from all machines as connected components of id plus alias edges.
  This is one pure function in a shared package, used by web and iOS. Don't duplicate it.
- Merging logical project Q into P means:
  - every online daemon that holds Q re-points its registrations to P;
  - the daemon doing the merge records the alias Q→P;
  - an offline daemon still reporting Q is grouped correctly through the alias, with no
    propagation needed.
- Linking one registration to P only sets that registration. It records no alias.
- Unlinking a registration gives it a fresh id. It never deletes an alias.
- Commands:
  - `workspace.identity.link {workspaceId, identityId}`
  - `workspace.identity.unlink {workspaceId}`
  - `workspace.identity.merge {from, into}`
  - All three are idempotent, and each workspace push emits `workspace.changed`.

### 4. The list shows one entry per logical project, with checkouts listed beneath it

- Each checkout shows machine, path, repo-relative subpath and primary repository.
- Each machine has a default checkout (most recently used, from `workspace_recent`). Starting
  work offers machine and checkout choices.
- A client cache keeps the last list from each machine. A logical project seen only on an
  offline machine stays listed, marked offline and not selectable. Its checkouts never read as
  current.
- **Metadata stays per registration in v1** (name, icon, badge, notes, defaults, repositories).
  - The group label is this machine's registration name, else the most recently used one.
  - When names differ, show a disambiguation line.
  - No cross-daemon metadata sync and no conflict resolution in v1.

### 5. Suggestions are computed lazily and bounded

- A new request, `workspaces.identitySuggestions`, returns candidates within the same identity
  scope:
  - same normalized remote: any remote, not just origin;
  - same repo-relative subpath;
  - marker id (stage 4).
- The client asks for suggestions from each machine and shows them. Nothing is applied until the
  person confirms.
- Reads are bounded the way `OriginCache` already does it: bounded concurrency, TTL cache, a cap
  per request with a cursor instead of the silent 64-project cut-off.
- A shared remote with a different subpath is not a suggestion.
- A fork (different remote set, or the forge reports it as a fork) is shown as "fork of …", with
  "keep linked" or "new project". It never links automatically.

### 6. Transfers keep identity, with negotiation

- The target's begin reply advertises `identity: true`. Only then does the sender send its
  identity and aliases in `commit`, or in a new non-strict field gated the same way.
- New landing: the registration takes the sender's identity.
- Reusing an unlinked registration: it takes the sender's identity.
- Reusing a registration with a different identity: don't overwrite it. Return `identityConflict`
  in the result so the client can offer to link.
- Reuse by identity applies only where it fits the method:
  - for `remote`, the matched registration must also have the same normalized origin;
  - for bundle and archive, the git-ness must match, as `landedFor` checks today.
- Otherwise the existing rules apply unchanged (same origin, then earlier landed copy).
- The marker never affects where a transfer lands. That matters because reuse merges `.env` and
  other ignored files into the checkout.
- When the client sees an identity, it uses it instead of `copiedProjects` for New thread's
  machine move (`moveResolver`): identity match first, then the old fallback.

### 7. The marker is opt-in and only a hint (separate PR, plus a new ADR)

- It is written only when the person chooses "Share identity with clones". ace writes the file
  and never commits it.
- Contents: `{version: 1, id, name?}` and nothing else. No paths, hosts or credentials.
- Read it as untrusted data (ADR 0125):
  - regular file only, opened without following symlinks; no FIFOs or devices;
  - 4 KiB cap and a timeout;
  - schema-parsed;
  - an invalid file reads as absent.
- Read it only on add or inspect, or lazily for suggestions. Never at daemon open.
- When adding a folder whose marker names a known identity, the add flow shows a link
  confirmation, with link as the default. One confirmation per registration.
- A subfolder project's marker lives in that subfolder.
- Read-only repos work entirely without a marker.
- Write it through the ADR 0063 descriptor boundary, with exclusive create, and never overwrite a
  marker that names another id without asking.

### 8. Fallbacks for old daemons

- Keep `workspace.origin`, `workspaces.match` and `copiedProjects` as fallbacks when a daemon
  reports no `identity`.
- New ops sent to an old daemon fail with an unknown-op error; the client treats that as
  "unsupported" and hides linking for that machine.
- Fix the 64-project cap and the lowest-id tie-break in `sameOriginProject`. Prefer the
  registration with an exact subpath match, then the most recently used one.

### Not in scope

- ace thread worktrees stay execution roots, not registrations.
- User-made `git worktree` and clone folders are separate registrations that can be linked.
- Provider sessions are untouched.

## Staging

1. **Storage and wire:**
   - the tables;
   - the optional `identity` on `Project`, in `packages/protocol`, schema only;
   - link, unlink and merge commands, plus the suggestions request;
   - fake daemon support (`packages/fake-daemon/src/workspace-wire.ts`);
   - capability handling for old daemons;
   - the `sameOriginProject` fixes.
2. **Web, then iOS:**
   - the pure grouping function in a shared package;
   - the grouped list with machine and checkout pickers;
   - offline caching;
   - the link and suggestion UI;
   - replacing `moveResolver` with identity first and the old fallback after.
3. **Transfers:** negotiation, adopting identity, and `identityConflict`.
4. **Marker:** the ADR, opt-in writing, the bounded reader, the confirmation in the add flow, and
   the fork prompt.

Stages 1–3 are approved for implementation. Stage 4 is approved in the opt-in, hint-only form
above, but needs its new ADR and a PR of its own, because it makes an exception to ADR 0120.

## Acceptance tests (behaviour, through public APIs)

1. A daemon opened on an existing home keeps every workspace id and thread binding. Each project
   lists as unlinked, with no Git process or marker read started at open.
2. Two machines with the same origin are listed separately with a suggestion, until the person
   links them. After linking, they show as one entry with two checkouts, each naming its machine
   and path.
3. Merging Q into P while a third machine holding Q is offline groups all three once it
   reconnects (alias). Unlinking one registration splits off only that one.
4. A monorepo with `api/` and `web/` registered gets no suggestion between them. Each matches only
   the same subpath on the other machine.
5. A copied marker in an unrelated repo produces only a suggestion. Without confirmation it is
   never grouped, never chosen as a transfer landing, and never receives ignored files.
6. Markers that are a symlink, a FIFO, larger than 4 KiB, or malformed read as absent without
   hanging.
7. A fork that inherits a marker shows a "fork of" prompt. Picking "new project" mints a new
   identity, and the original's registrations are unchanged.
8. New sender to old target (strict begin) still transfers, with no identity sent. Old sender to
   new target lands as it does today.
9. A transfer to a new landing or an unlinked reused registration gives it the sender's identity.
   A transfer to a registration with a different identity keeps the target's identity and reports
   `identityConflict`.
10. Remote-method reuse by identity is refused when the matched registration's origin differs; it
    falls back to the existing rules.
11. An old daemon in the pool: its projects list as singletons, linking is hidden for it, and New
    thread falls back to origin and copy matching.
12. With 100+ projects, origin matching still finds a match past the 64th, and with two checkouts
    picks the exact subpath match, then the most recently used one.
13. Two registrations on one machine with the same identity both stay selectable, and the default
    is the most recently used.
14. Renaming on one machine never renames the other machine's registration. The group label
    follows the rule in section 4.
15. A logical project known only on an offline machine stays listed, marked offline, and can't be
    picked to start work.
16. Link, unlink and merge are refused without `projects` authority, and are idempotent when
    repeated with the same request id.
17. Identity never changes a thread's `workspace_id`, provider or session, before or after link,
    unlink or merge.
