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
   repositories are refused first (ADR 0120).
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
- **Bitbucket Cloud** (`bkt`, a vetted third-party CLI; [ADR 0118](0118-bitbucket-through-bkt.md)):
  reviews, comments and verdicts. Data Center isn't supported.
- **GitBucket**: blocked until an official CLI exists (ADR 0002).

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
  including replies and resolve), approvals and reviewers (read and write, including requesting
  reviewers), pipelines as checks with retry and cancel, merge pinned to the head SHA, "merge when
  pipeline succeeds" as auto-merge, merge request create and edit (title, body and other
  metadata, draft and ready, close and reopen, lock and unlock), issues (read and write), and
  to-dos as the inbox.
- **Gitea and Forgejo** (`tea`): reviews, files, commits, conversation and new line comments
  (read and write), approvals (read and write), commit statuses as checks, merge pinned to the
  head SHA (from the pull request page and from a linked thread), and issues (read and write).
- **Cursor Origin**: reviews and files, read only.
- **Bitbucket Cloud** (`bkt`, ADR 0118): reviews, files, commits, comments and inline comments
  with replies (read and write), approvals and requested changes (read, write and withdraw),
  and build statuses as checks.

Replying inside a review thread (`reviews.comments.reply`) and asking people to review
(`reviews.reviewers.request`) are capabilities of their own, apart from commenting and approving,
because Gitea and Forgejo do the latter but not the former.

How host data maps, where a host says less than GitHub:

- **Unknown is never passing.** A pull request row with no review decision or no CI is unknown,
  not ready: it waits and says "Review status unavailable". `reviewDecision` null means the
  repository requires no review; `UNKNOWN` means the host can't say. A merge state whose rules
  the host can't confirm is `UNKNOWN`, never `CLEAN`.
- **GitLab approvals**: APPROVED needs a real approver or a satisfied rule that requires one.
  GitLab also marks an MR approved with nothing left when no approval is required, so that alone
  is null only when GitLab says none is required, and `UNKNOWN` otherwise.
- **GitLab pipelines**: skipped jobs, manual jobs that may fail, and failures GitLab allows
  (shown as a warning) are neutral: they never block and never count as passed. A manual job that
  may not fail, and every job still under way, keeps the pipeline pending. An MR with no pipeline
  is blocked only when the project's "pipelines must succeed" setting
  (`only_allow_merge_if_pipeline_succeeds`) is on or can't be read. `need_rebase` is `BEHIND`.
- **GitLab to-dos** carry the inbox's shared reasons (`assigned` is `assign`, `mentioned` and
  `directly_addressed` are `mention`, and so on); actions with no equivalent keep GitLab's name.
- **Gitea merges**: `mergeable` only means no conflicts, and branch protection and required
  approvals aren't read, so the merge state is `UNKNOWN` and the review decision `UNKNOWN`. A
  draft (Gitea's draft flag or a WIP title) reads as `DRAFT` and is refused before anything is
  sent; the host enforces its own protection on the pinned merge.

- **Bitbucket**: an OPEN pull request with Bitbucket's draft flag is `DRAFT`; DECLINED and
  SUPERSEDED are closed; any other state is unknown. Pull requests name abbreviated hashes, so
  the head is the newest of the pull request's own commits and must be the one it names, or the
  read fails. A build status INPROGRESS is pending, STOPPED cancelled (failing CI), and one for
  another commit is left out; one naming no commit is unknown. Mergeability and required
  approvals aren't read: mergeability is unknown and the review decision `UNKNOWN`. Bitbucket
  approvals have no id, so a verdict's id is derived from its reviewer's uuid, and only the
  viewer's own can be withdrawn.

Every GitLab adapter shares one transport, `GitLabApi`: the endpoint guard, the read budget,
status mapping, and one rule for writes. Only an explicit refusal (400, 401, 403, 404, 405, 409,
412, 422, 429) seen under an unchanged identity has definitely failed; any other failure after
dispatch, and an identity change after a success, is uncertain. Every tea write goes through one
function, `teaWrite`, and every bkt write through `bktWrite`, with the same rule
(`refusedWriteStatuses`).

Each adapter's admitted writes are built for one repository (`writesUnder`): the GitLab project
path or the Gitea `owner/name`, and one MR or pull request for review writes. Admission itself
refuses another repository. A GitLab MR from a fork is posted to the fork, so creation admits
exactly the target and that fork, and the fork is refused like the target when the project hides
it. GitLab to-dos are account-wide, so marking one done isn't scoped to a repository. In the daemon, `host-routes.ts`
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
  stacks, suggestions, reactions, media and check detail pages; requesting reviewers; and replies
  inside a review thread. Released Gitea (1.25) and Forgejo have no API for those replies:
  `POST repos/{owner}/{repo}/pulls/{index}/comments/{id}/replies` exists only in Gitea's
  unreleased development API (gitea.com/swagger.v1.json), and Forgejo's
  (codeberg.org/swagger.v1.json) has none, so ace neither sends nor offers them. Reading branch
  protection and required approvals, which would let a Gitea merge state be `CLEAN`.
- **Cursor Origin**: every write.
- **Bitbucket**: merge (Bitbucket's merge takes no expected source commit, so it can't be pinned),
  issues (Atlassian removed them from Bitbucket Cloud on 2026-08-20), pull request create and
  edit, reviewer requests, resolving threads, multi-line comments, auto-merge, the inbox,
  stacks, suggestions, reactions, media, patches in the file list (diffstat has none),
  per-state list counts and searches, and Data Center. Bitbucket doesn't say whether an inline
  comment is outdated, so none reads as outdated. The hidden marker on ace's comments is a
  Markdown reference definition, which needs confirming against Bitbucket's renderer.
- **GitBucket**: blocked until an official CLI exists.
