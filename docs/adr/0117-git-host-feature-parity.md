# 0117: Git host feature parity through declared capabilities

Status: accepted

## Context

GitHub's integration covers reviews, comments, approvals, checks, merge, auto-merge, stacks,
issues, inbox, reactions and media. GitLab and Cursor Origin are read-only (#1686), and clients
decide what to show by checking `forge === "github"`. Adding features host by host that way
scatters special cases across the daemon, web and iPhone.

ace still reaches every host only through the user's own logged-in CLI (ADR 0002).

## Decision

1. **The daemon declares what each repository's host supports.** `ForgeCapability`
   (`packages/protocol/src/forge-capabilities.ts`) names each feature. The daemon reports them on
   every `ProjectRepository` and every `ForgePrDetail` from one table,
   `forgeCapabilities` in `@ace/forge`. Clients show a control only when its capability is listed
   and never test the provider. With no capabilities on the wire (an older daemon), clients keep
   their previous behaviour: everything for GitHub, reads only for others.
2. **An adapter adds a capability in the change that implements and tests it**, never earlier.
3. **Writes are admitted one exact shape at a time.** Each adapter lists its writes
   (`HostApiWrite`: method plus endpoint pattern) beside the code that sends them. glab writes are
   exactly `glab api <endpoint> -X <METHOD> --hostname <host> --include --input -` with a JSON
   object on stdin. `SourceControl.writeIdentity` admits reads plus those writes, proves the
   account before and after each write, and refuses everything else. Hidden or unavailable
   repositories are refused first (ADR 0116).
4. **Host data maps into ace's existing shapes.** GitLab discussions are review threads,
   approvals are reviews, pipelines are checks, "merge when pipeline succeeds" is auto-merge,
   to-dos are the inbox. `#N` is an issue and `!N` a merge request on GitLab. Where a shape is
   GitHub-specific, it gains a neutral field rather than a provider branch in clients.
5. **Uncertain writes are reconciled as GitHub's are**: a write whose result wasn't seen is
   uncertain until a read settles it.
6. **One behaviour table per capability** runs against every adapter with hand-made CLI replies
   built from each host's API documentation; no real accounts and no quota.

## Hosts

- **GitLab** (`glab`, official): every capability except stacks is in scope.
- **Gitea and Forgejo** (`tea`, Gitea's official CLI, with `tea api`): one adapter for both; reads
  first, then writes. Its exact write shape is defined by that adapter with the same rules as glab.
- **Cursor Origin**: reviews only; its API has no issues. Writes later, once its CLI write shape
  is confirmed.
- **Bitbucket and GitBucket**: blocked until an official CLI exists (ADR 0002).

## Consequences

Clients lose every `forge === "github"` branch. New host features need no client change when
their data fits existing shapes. The capability table is the one place reviewers check that a
host claims only what it implements.

## What is built

`forgeCapabilities` in `packages/forge/src/forge-capabilities.ts` is the source of truth; the
daemon attaches it to every `ProjectRepository`, `ForgePrDetail` and `ForgeIssueDetail` at its
browse boundary, and web and the iPhone gate every control with `can()` from `@ace/ui-core`.
The separate read-only hosted review screens are gone: every host renders the one review page,
showing what its capabilities declare.

- **GitHub**: everything.
- **GitLab** (`glab`): reviews, files, commits, discussions as review threads (read and write,
  including resolve), approvals and reviewers (read and write), pipelines as checks with retry and
  cancel, merge pinned to the head SHA, "merge when pipeline succeeds" as auto-merge, merge
  request create and edit (title, body and other metadata, draft and ready, close and reopen, lock
  and unlock), issues (read and write), and to-dos as the inbox.
- **Gitea and Forgejo** (`tea`): reviews, files, commits, comments (read and write), approvals
  (read and write), commit statuses as checks, merge pinned to the head SHA, and issues (read and
  write).
- **Cursor Origin**: reviews and files, read only.

Every GitLab adapter shares one transport, `GitLabApi`: the endpoint guard, the read budget,
status mapping, and one rule for writes. Only an explicit refusal (400, 401, 403, 404, 405, 409,
412, 422, 429) seen under an unchanged identity has definitely failed; any other failure after
dispatch, and an identity change after a success, is uncertain. In the daemon, `host-routes.ts`
and `hosted-browse.ts` pick each host's adapter in one place, `hosted-issues.ts` does the same for
issues, and every non-GitHub writer goes through `ForgeBackends.admittedWriter`, which refuses a
hidden repository and then admits exactly that adapter's writes. Uncertain writes reconcile
through the existing journals: issue actions, PR write receipts, hosted review writes and
lifecycle writes. No host has a journal of its own.

## Not yet supported

- **GitLab**: stacks, suggestions, reactions and media; viewed-file state and moving review drafts
  to a new head; the inbox marks a to-do done but has no read, unsubscribe or mark-all-before;
  dequeuing from a merge train; updating, reverting or deleting and restoring a merge request's
  branch, linking issues, and lock reasons; new merge request options (labels, assignees,
  milestones) read empty. Resolving a discussion sends `PUT …/discussions/:id` with a JSON body `{resolved}`, while
  GitLab's documentation shows only the query form. It needs confirming against a real instance.
- **Gitea and Forgejo**: check reruns, auto-merge, pull request create and edit, the inbox,
  stacks, suggestions, reactions, media and check detail pages. Actions on a pull request linked
  to a thread (merge, reply, review request from the thread) fail closed as unsupported; the same
  actions from the pull request page work.
- **Cursor Origin**: every write.
- **Bitbucket and GitBucket**: blocked until an official CLI exists.
