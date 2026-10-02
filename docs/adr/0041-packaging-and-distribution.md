# 0041: Daemon packaging and distribution

Date: 2026-10-02. Status: accepted.

## Context

The competitor inventories describe t3code's background service and auto-update, Claude Remote Control's reconnect behavior, and Antigravity's headless remote-control daemon. They do not establish that updates preserve active agent trees or reverse incompatible database migrations. ace needs those guarantees before desktop and remote clients depend on an unattended daemon. These inventories are feature references only. No competitor implementation is used.

## Decision

Ship four deterministic archives, darwin-arm64, darwin-x64, linux-arm64 and linux-x64. Each contains a pinned Node 24 runtime, an ESM daemon bundle, the notification and model persistence worker bundles, node-pty's native prebuild and helper, licenses, and a file checksum manifest. Build inputs carry checksums. Tar entries have sorted paths, fixed timestamps, ownership and modes; gzip omits timestamps. Electron will launch this exact artifact as a child process, avoiding an Electron ABI rebuild.

Use a vendored runtime instead of Node SEA. Node's SEA documentation requires native addons to be written to disk before loading. SEA also couples blob generation to the exact runtime and has platform signing and cross-compilation constraints. Vendoring keeps the native loader and worker paths ordinary files and preserves Node's signature. The modest extra files are preferable to extraction code in daemon startup. [Node SEA documentation](https://nodejs.org/api/single-executable-applications.html).

`packages/service` owns pure service plans and update admission, plus filesystem, subprocess and streaming HTTP boundaries. macOS uses a user LaunchAgent with RunAtLoad, KeepAlive and throttling. Linux uses systemd --user, default.target and a bounded restart interval. Never install root services or enable lingering. Login services inherit an explicitly recorded PATH, ACE_HOME and validated daemon network/log settings. Provider credential variables are excluded. macOS logs go to ACE_HOME/logs; Linux uses the bounded system journal. `ace service install|uninstall|start|stop|status` reconciles state idempotently. `ace status` checks the authenticated local HTTP endpoint. [Apple launchd guidance](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html).

The update CLI is an external process. A signed release manifest binds version, channel, target, archive size and SHA-256. Ed25519 verification uses a public key embedded at build time, never a key supplied by the feed. Missing release authority fails closed. Keys are generated and stored outside the repository, preferably by an offline release signer or secret manager. Rotation requires a release signed by the old authority with an intentionally reviewed new embedded key. TLS protects transport but is not the release authority.

Check the GitHub Releases API over HTTPS. Download archives as streams with size and duration bounds. Verify signatures before downloading, checksums before extraction, and reject traversal, links and unexpected entries. Immutable version directories live under ACE_HOME/releases; a same-filesystem rename of a temporary symlink replaces `current` atomically. Launchers resolve that pointer once and use the immutable generation for both Node and JavaScript. Keep `previous` and a durable transaction journal. Serialize installers/updaters with an exclusive directory lock. A crash leaves a journal that the next updater recovers before proceeding.

Before stopping, acquire a local maintenance lease which closes command admission and returns a whole-thread blocker count. Without `--drain`, release the lease if work exists. With explicitly approved `--drain`, wait for natural completion, bounded by a deadline; never interrupt a turn, approval or background task. Existing provider work may finish. Human approval answers and explicit stop commands remain available during drain; new user work is refused. The daemon exposes its maintenance gate for engine turn admission. A future engine must honor this admission barrier for autonomous turn starts too.

After service stop, snapshot every SQLite database with SQLite's backup API, including WAL contents. The candidate runs its own migrations against these copies and checks integrity. Failure blocks the swap and restarts the old version. Preserve the pre-migration copies until health succeeds. On failure restore both the old binary pointer and database copies while stopped, then restart and check the old version. Version-aware health probes prevent an unrelated daemon from satisfying readiness.

## Protocol and wire additions

Add schema-only release manifest and maintenance response definitions. Local authenticated POST /v1/maintenance enters drain mode; DELETE releases it; GET returns admission state and blocker count. Remote devices cannot operate the lease. GET /v1/status gains version. Websocket commands that start or send new work receive a maintenance error while admission is closed. There are no provider credential changes.

## Security and operations

POSIX install.sh downloads to a private temporary directory, verifies an archive checksum pinned in the trusted installer using platform hash tools, then uses that authenticated Node runtime to verify the manifest signature before invoking the bundled installer. This avoids requiring OpenSSL 3 on macOS. It never pipes a download into sudo. Homebrew templates bind architecture-specific archive hashes. Uninstall removes only ace's unit, launcher and artifact directories and preserves user databases. Local update polling runs daily through the service supervisor and can be disabled at install and uses the same authenticated updater. Signing and publication are separate from reproducible unsigned builds.

## Performance and testing

No transcript replay is needed for update admission. An incrementally maintained SQLite blocker index answers admission with an indexed existence/count query. Release downloads and hashing are streamed; manifests and feed bodies have fixed caps. There is one updater per installation, one candidate and one rollback generation. Benchmarks measure hashing throughput and RSS without gating on time.

Tests parse generated plist and unit semantics, use injected fake service executables, real temporary directories, SQLite WAL databases, local HTTP servers and generated Ed25519 keys. Cover idempotence, escaping, checksum/signature rejection, atomic pointer replacement, rollback and database restoration, active-thread refusal, concurrent command admission, migration failure, bounded downloads and interrupted transactions. At least eight production mutations must each fail a behavior test before delivery.
