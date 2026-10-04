# 0063: Client project management

Date: 2026-10-03. Status: accepted.

Clients cannot register a project today. Add durable `workspace.add`, `workspace.create`,
`workspace.clone`, `workspace.rename` and `workspace.remove` commands using ADR 0057 admission
and receipts. Return the workspace in the receipt so the client can select it immediately.
The same add API handles `ace://open?folder=...` and `/new?folder=...`; routing and native
dialogs remain client work.

Keep project policy and registration separate from thread execution roots. Canonicalize
existing directories before policy checks and registration. Adding an alias returns the same
workspace id. Inspect Git through `@ace/git`, returning the repository root, branch, default
branch and remotes. A subfolder add returns a root suggestion; selecting it requires another
explicit add. No folder moves occur during rename or removal.

`projects.request` provides `workspace.inspect`, `fs.home`, `fs.recentFolders`, `fs.browse`
and `workspace.clone.cancel`. Browse uses bounded directory scans, name cursors and a maximum
page of 100 entries. It hides dot-directories by default and checks every canonical target
against `projects.roots`. Empty roots settings mean the host user's home. System directories
are denied even when a configured root contains them. Settings are read globally on the host.

Project commands and filesystem reads require `projects` authority. The local owner and
local desktop credential can use it; paired devices must explicitly receive `projects`.
Unlike existing scopes, remote admin does not imply projects. Recheck authority after awaited
work and before registration or delivery. Cancellation is restricted to the clone's device.

`@ace/git` owns init, clone, progress parsing and process cancellation. Clone accepts HTTPS,
SSH and scp-style `git@` URLs, uses argv with no shell and restricts Git transport protocols,
including redirects and recursive transports. ace never reads credentials or forwards raw
Git stderr. Tests alone can inject a file URL validator and file transport fixture. Cancellation
waits for process cleanup before its final receipt. Failed or cancelled clones never register;
partial directories remain available for host inspection and are not recursively deleted.

Pin project and parent directory identities through `@ace/workspace`'s descriptor boundary.
Create folders with `mkdirat`, write templates with exclusive `openat`, and enter Git's cwd
through an inherited directory descriptor in a supervised helper. Path checks alone cannot
protect writes when another local process replaces a directory. Reject changed identities
immediately before registration. Read branch/remotes without status or untracked enumeration.
Recheck clone cancellation at that commit boundary; cancellation after commit returns
`clone_not_running`. Start Git closure before draining commands so stalled metadata cannot
delay shutdown until the operation timeout.

Removal persists an unregistered marker rather than deleting workspace rows referenced by
thread history. It never deletes files. Live whole-tree statuses refuse removal unless
`archiveThreads` is supplied. Explicit archive preserves execution status and ongoing work.
Re-adding restores registration with the same id. Rename updates thread workspace metadata.
Workspace pushes invalidate project lists; thread events update existing sidebar subscriptions.

Expose `ClientApi.projects` through both in-process and shared-worker clients using the existing
command, request and message forwarding. The fake daemon owns a separate project catalog so
empty projects remain visible. No UI code belongs to this change.

The next free number is 0063. Both 0056 records already exist. Open PR #90 reserves 0062
for long-thread APIs. This change does not edit its ADR or transcript owners.
Behavior tests cover canonical idempotency, root suggestions, create, clone progress and
cancellation, policy, removal, scope enforcement and browse bounds. Tests and mutation cases
are not executed; tests run at merge. Only the owner-approved static checks run here.

Git argument and transport choices follow the primary [clone](https://git-scm.com/docs/git-clone),
[protocol policy](https://git-scm.com/docs/git-config#Documentation/git-config.txt-protocolallow)
and [init](https://git-scm.com/docs/git-init) references.
