# Source control on a machine

Settings > Source control inspects that daemon's installed `gh`, verifies its effective
API login, and rescans after the person signs in using their own CLI. Older CLIs without
JSON auth status still expose the effective API login. Newer versions can list stored
accounts through a projection containing only login and active status.

Global `sourceControl.preferences` stores configured GitHub hosts, an optional expected
account for each, the selected host, and a repository remote name. Administrator authority
is required to write it; workspace/thread assignments are refused. No tokens, auth headers
or credential files enter ace. Host settings do not rewrite Git remotes.

An expected account mismatch blocks requests and shows `gh auth switch` instructions.
ace never switches shared CLI state during a read. Forge requests check the effective API
login before and after each operation. If another process changes the CLI account during
a write, its result is uncertain and existing forge reconciliation still applies. External
CLI changes cannot be locked by ace. Backends/cache entries include host, repository,
working directory and effective account. Reconnecting or changing client clears readiness;
a fresh scan always probes the CLI rather than returning a cached capability.

Configured Enterprise hosts reach remote detection and PR URL linking. The selected remote
must exist. Transport checks select a project and run bounded, cancellable `git ls-remote`
with prompting disabled. A successful read proves read transport access only; push permission
is checked by a push. API identity and Git's SSH/credential-helper identity can differ.

Process tests replace only gh, keep real child processes and settings files, and cover old
CLIs, missing CLI, login changes, mismatches, concurrent identity guards, malformed identity,
Enterprise URLs, cancellation, authenticated sockets and restart persistence.

Preferences have a daemon-local revision. Saving a different host, remote or expected account
invalidates cached forge backends. Operations check that revision after identity probes, before
later CLI commands, and before publishing results. A settings change therefore cannot authorize
an already-admitted request to continue under the previous account.

A successful remote write followed by an identity or preference change reports an uncertain
outcome instead of a sign-in rejection. Reply receipts persist the remote comment ID and account
in the daemon database. Retrying the same reply with a new command first reads that comment and
verifies its author, body and parent; it does not post another reply. Restore the intended account
before retrying. If the comment was changed or removed, reconciliation stops for human review.
