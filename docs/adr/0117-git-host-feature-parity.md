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
