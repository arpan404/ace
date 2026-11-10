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

`resolveProjectRepositories` (daemon) takes the checkout's remotes, the global preferences,
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

- **All visible repositories**: Code review lists (clients read `forge.repositories` and send
  `forge.pr.list` with each `repository`), the inbox (it tags rows with every visible
  repository on the inbox's host), and link refresh (each link is already refreshed on its
  own repository, so links on any of them stay current).
- **The primary**: new pull requests, `forge.repository`, a thread's `details.repository`,
  targeted pushes and every other single-repository feature.
- **Writes**: a write naming a repository the project lists as hidden or unavailable is
  refused (`repository_hidden`, `repository_unavailable`). A repository the project doesn't
  list (a fork's parent, say) is unchanged by this ADR.

## Consequences

- Clients show a project's repositories in its settings and list reviews from each visible
  one. Old clients keep working: `forge.repository` is the primary.
- A new remote on a known host appears without any action; hiding it is one choice.
