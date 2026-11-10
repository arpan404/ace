# 0116: A project's Git repositories

Status: accepted. Date: 2026-11-09. Owner decision of 2026-11-09 ("Remotes + manual"). Builds
on the Git host providers of PR #1686 (`ForgeKind`, `SourceControlPreferences`).

## Context

A project mapped to exactly one hosted repository: `workspaceRepository()` took the remote
named by the global source control setting (`remote`, default `origin`), else the first
remote. A checkout with `origin` on GitHub and a mirror on GitLab, or an `upstream` beside a
fork, showed one of them and nothing of the rest. Code review, linking, the inbox, new pull
requests and checkout details all assumed that one repository.

## Decision

### Repositories come from remotes, plus the person's own additions

- A project's repositories are every remote of its checkout whose first fetch URL maps to a
  known host: a public host (`publicForgeHosts`) or one configured in source control
  settings. The mapping is `repositoryFromRemote` with `configuredForges` and the SSH host
  aliases `SourceControl.hostAliases` resolves. A remote on an unknown host is not listed.
- In the project's settings the person can **add** a repository by hand (provider, host,
  owner, name; it need not be a remote), **hide** one, and pick the **primary**.
- The global host list (which hosts exist, their provider, expected account) stays global.
  Per-project state is only which repositories this project uses.

### One pure resolver

`resolveProjectRepositories` (`@ace/forge`, shared by the daemon and the fake daemon) takes the checkout's remotes, the global preferences,
the aliases and the project's saved choices, and returns the resolved list and the primary.
It does no I/O. `workspaceRepository()` is its primary, so every caller that wanted "the
project's repository" now gets the primary through the same rule.

### Identity

A repository is `provider + host + owner + name`, compared without case (`repositoryKey`).
Two remotes naming one repository are one entry, named after the global remote name when
that is one of them, else the first. A manual entry equal to a remote's repository is that
remote's entry; the manual one stays saved and returns if the remote goes away.

### The primary

1. The saved primary, when it is listed, visible and available.
2. Else the repository today's rule picks (the global remote name; with no preferences, the
   first remote), unless hidden.
3. Else, only for a project with saved choices, the first visible, available repository.
4. Else none.

A project with no saved choices therefore behaves exactly as before.

### Availability

An entry is listed but unavailable, never dropped, when:

- `host_not_configured`: a manual entry's host is neither public nor configured (the host was
  removed from settings);
- `provider_mismatch`: its host is configured with another provider now;
- `provider_unsupported`: ace reads no pull requests from its provider (`readableForges`);
- `remote_missing`: it is the saved primary but no remote names it any more.

A remote that disappears drops out of the list; its hidden or primary choice stays saved and
applies again if the remote returns. Manual entries are only removed by the person. Nothing
here ever deletes threads, links or any other data.

### Where the choices live

In the daemon's own per-project data: a `repositories` JSON column on `workspace_metadata`,
beside the icon, badge, defaults and notes. Never in the user's repository or Git config,
which belong to the person and their collaborators. `migrateProjects` adds the column when
missing, the same forward-only way it added the others; there is no backfill, since an
absent value means "no saved choices". A value that no longer parses reads as absent.

### Which features use which repositories

- **All visible, available repositories**: Code review's pull request lists (clients read
  `forge.repositories` and send `forge.pr.list` with each `repository`, by `reviewSources` in
  `@ace/ui-core`) and link refresh (each link is already refreshed on its own repository, so
  links on any of them stay current).
- **Issues**: the same repositories, less those whose provider ace reads no issues from
  (`issueReadableForges`, GitHub only today), by `issueSources`. A GitLab mirror lists its
  merge requests in Pull requests and nothing in Issues, rather than a failure on every read.
  Web and the iPhone use the same two functions. New issues open on the primary.
- **The inbox** tags each notification with a project by its repository. Every project's
  primary is matched first, so a row never moves from the project whose primary it is to
  another that also uses that repository. Only a project with saved choices adds its other
  visible, available repositories, after every primary; with no saved choices the tagging is
  exactly the primaries', as before.
- **The primary**: `forge.repository`, a thread's `details.repository`, where new pull
  requests open and every other single-repository feature.
- **Writes**: a write naming a repository the project lists as hidden or unavailable is
  refused (`repository_hidden`, `repository_unavailable`): pull request writes, checks, reviews,
  stacks and issue writes (`forge.issue.write`). `forge.issue.reconcile` only reads whether an
  earlier write landed, so an uncertain write still settles after its repository is hidden. A
  repository the project doesn't list (a fork's parent, say) is not the project's to refuse.

### Pushes and new pull requests

- A **plain push** (commit and push, push, the merge-conflicts push) names the global remote
  name, exactly as before: choosing a primary never changes where a plain push goes.
- The **push before a new pull request** (`git.push` with `target`) goes to the PR's head,
  which the daemon picks (`resolvePrHead`):
  1. the global remote name's repository, when it is the primary or a fork of the primary (the
     host's repository metadata says so): the fork workflow pushes to the person's fork and the
     PR opens on the primary from `fork-owner:branch`;
  2. else the primary's own remote.
     The client names the primary it saw as `target.repository` and the global remote name as
     `remote`; anything else is refused with `repository_mismatch`. Without saved choices only the
     global remote name is pushed to, as before.
- **Where the PR opens**: on the pushed repository's fork parent when it has one (as before),
  else on the pushed repository. A fork parent the project lists hidden or unavailable is not
  used: hiding a fork's parent keeps the project's new pull requests in the fork itself, rather
  than refusing every new pull request.

### Saving choices from several devices

`workspace.repositories.set` names the choices the edit started from (`expected`, the read's
`config`). When the saved choices are others by then (another device saved in between), the set
is refused with `repositories_changed`. Clients apply one edit at a time with the pure edit
functions, so on that refusal they read `forge.repositories` again, re-apply the same edit to
what is saved now, and save once more (`saveRepositoryEdit`); a second refusal is shown. A set
without `expected` (an older client) replaces whatever is saved.

### When the repositories can't be read

A project whose `forge.repositories` read fails is read through its primary alone, as before,
but the list says so in one sentence ("Couldn't read the repositories of api, so only its
primary is listed.") and its totals stay unknown, so a list that may miss repositories never
looks complete. Totals and counts are summed only when every repository's read answered in
full.

## Consequences

- Clients show a project's repositories in its settings and list reviews from each visible
  one. Old clients keep working: `forge.repository` is the primary, and a push naming the
  global remote name is what they always sent.
- A new remote on a known host appears without any action; hiding it is one choice.
