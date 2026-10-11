# Repository discovery and publication

Add project → GitHub repositories reads the selected machine's CLI identity, configured host and explicit account. Search covers the accessible authenticated repository set, including private repositories and organizations, with owner, visibility, archived and fork filters. Twenty pages / 2,000 repositories and 8 MiB of source data are the hard bound; a larger set reports a limit rather than implying the list is complete. Changing machine, host, account or filters owns a new cancellable read. No read changes CLI authentication.

Selecting a repository supplies its canonical HTTPS URL to the existing Clone form. Destination validation, progress, cancellation and retry keep their existing owners. Git URL remains a source for SSH and pasted addresses. API sign-in does not prove Git transport permission.

The project menu's **Publish repository…** reviews host, account, owner, name, description and visibility, defaulting to private. Only its explicit submit sends a write. The daemon requires project-management authority, an allowed registered repository root and no existing origin. It pins the directory and uses the existing Git service, serial mutation ownership and bounded noninteractive process shell.

A SQLite record stores intent before dispatching creation, then the returned repository's immutable id before adding origin. A lost create reply or restart in the `creating` phase performs exact owner/name lookup, checks the requested metadata and records the identity; it never repeats creation. Once an identity is recorded, reconciliation checks its id before local effects. Existing origin must match that saved remote exactly; otherwise publication stops. Push pins the destination, revision and branch without replacing origin or force-pushing. A preflight failure before creation permits a corrected form; a dispatched intent is retained and locked.

The dialog shows phases, a link to any created repository, actionable stable error text and **Resume publication**. Closing the dialog/disconnecting does not cancel the daemon-owned command. Reopen or Refresh status reads durable progress. Stop publication and device revocation abort owned processes; shutdown aborts and drains them. No remote is deleted on cancellation or failure. The persisted intent belongs to its device; another device cannot take over a partially completed write.

An empty repository creates the hosted repository and origin and reports `empty`. The dialog explains that the user must make the first commit before resuming the push. Successful local effects update the existing project catalog and inspection. The dialog invalidates active thread reads through the existing query cache so their Git controls refresh. Push failures preserve the created identity and explain Git credential-helper/SSH/permission recovery separately from API account access.

Creation can remain uncertain if GitHub does not expose the exact requested repository after dispatch. ace conservatively refuses another create. It does not auto-initialize Git, commit user files, modify CLI login, collect credentials, remove remote repositories or overwrite existing origin. A user changing GitHub metadata outside ace can require manual reconciliation. Normal clone access continues through the person's Git setup.

Primary contracts: [authenticated repositories / user and organization creation](https://docs.github.com/en/rest/repos/repos), [GitHub CLI API](https://cli.github.com/manual/gh_api).


Publication safety review

Before every push, the Git service pins HEAD and scans its tracked files and all newly reachable commit, tree and blob objects, excluding locally verifiable commits advertised by the destination. Historical tree names are checked separately so renaming an already-remote blob to `.env` cannot evade detection. Deleted/ignored files in unpushed history still block publication. Private-key markers, credential-bearing URLs and the shared `@ace/redaction` secret patterns are checked without logging matched content. Sensitive paths include `.env*`, private-key containers and credential stores. The public/private choice does not bypass the scan.

The scan fails closed for incomplete history, missing objects, Git LFS pointers and exceeded limits: 2,000 remote tips, 100,000 objects, 8 MiB per object, 128 MiB total content and 8 MiB metadata. Users receive cleanup guidance, including rotating exposed credentials and manually preparing clean history. ace never rewrites history. Scan and push use the same pinned revision and destination.

Creation admission and dispatch are separate durable facts. A synchronous transport callback records possible dispatch before spawning the write process; confirmed pre-dispatch failures restore an editable intent. An interrupted pending admission is retryable, while legacy/possibly dispatched attempts remain conservative. Confirmed create conflicts report a taken name and cannot adopt a competing writer's repository.

Git mutation guards run after serial admission, after metadata reads and at process spawn. Preference changes abort pending Git work. The daemon reports running work and whether the originating device can stop it; reopened/reconnected dialogs offer Stop and disable Resume while active. Completed command receipts update reopened dialogs.

Git object traversal and byte framing follow [rev-list](https://git-scm.com/docs/git-rev-list), [cat-file](https://git-scm.com/docs/git-cat-file) and [ls-remote](https://git-scm.com/docs/git-ls-remote).
