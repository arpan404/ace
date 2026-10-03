# Local ACP agent registry

`@ace/agent-registry` consumes the official ACP v1 index and resolves approved local installations. It exports one public surface, the package root. Launching an agent never downloads or updates it. The registry never authenticates, reads credentials, sends prompts or creates metadata sessions.

`AgentCatalog.open` loads a validated cache without network activity. `list` pages metadata; `refresh` explicitly fetches HTTPS and shares one bounded flight. Snapshot provenance retains schema version, content digest, ETag and an upstream release header when present. `entry` retrieves one source-qualified entry. `AgentRegistry.open` loads immutable installation records. Its `handle` method accepts the protocol's correlated registry requests. `bind` is a daemon-local API for explicit installed command bindings; it is not a wire route. `resolve` verifies the selected executable fingerprint and returns an immutable launch plan with the supplied account environment.

The pure API includes `decodeIndex`, `platformTarget`, `availability`, `matchProfile`, `buildInstallPlan`, `sessionSelectors` and `selectorRequest`. `fileCache` and `fileInventoryStorage` own bounded atomic JSON persistence. Unknown registry fields and future distributions survive decoding; future-only distributions are unavailable.

## Installation and identity

Official IDs use `official:<upstream-id>`. Other registry sources use `registry-<source-digest>:<id>` and cannot inherit official profile coverage. Explicit local bindings supply their own source-qualified IDs. Threads, native agent references and model rows carry `acpAgentId`, `installationId` and `instanceId` independently of `provider: "acp"`.

An install plan includes publisher, source, exact version, selected runtime/target, destination, argv and evidence. The digest includes the catalog snapshot, complete distribution and selected manager fingerprint. Listing exposes one bounded active-install phase and downloaded byte count; manager output is never forwarded. Execution requires a separate `registry.install-intent` with that digest and an idempotency ID. A changed snapshot needs another plan. npm packages must be exactly pinned; bare uv packages are pinned to the entry version. Package-manager execution is supervised and bounded. npm evidence retains the actual package-lock integrity. uv evidence records manager and package; it does not claim independently captured package hashes.

Binary downloads verify supplied SHA-256 before extraction. Raw files, ZIP and gzip tar archives are supported. Links, special files, encrypted ZIP entries, traversal, more than 10,000 entries and more than 256 MiB expanded data are refused. bzip2 archives and platform installers are unavailable. Digest directories are private and unregistered until inventory persistence succeeds; cancellation removes them and keeps prior installations. A process crash may leave an unregistered directory; it cannot launch, and reinstall refuses to overwrite it. Entrypoint fingerprints detect changed launch files, not every installed dependency; package-manager integrity is installation evidence rather than a continuously verified dependency tree.

Claude/Codex bridges require the user's native binary at binding time and again at launch. `CLAUDE_CODE_EXECUTABLE`/`CODEX_PATH` overrides cannot fall back to bundled defaults. The account owner supplies the selected `CLAUDE_CONFIG_DIR`/`CODEX_HOME` in memory. Registry metadata and inventory never store credentials or account-home overrides.

## Integration and support

The daemon registers this service through its service registry. Metadata listing requires read scope; refresh requires operate scope; installation controls require both local-admin and operate authorization. Clients call `Client.registry`. Remote inputs select IDs and digests, never executable paths or arbitrary argv. Daemon options provide `acpBindings`, `acpManagers`, `acpMcpServers` and `acpEnvironment(identity)` for local configuration and account-owned login revisions.

Initialize and authorized session setup determine effective capabilities before a prompt. Actual config IDs and dependent option replacements drive selectors. Generic modes use standard ACP; legacy model setters require a profile. Old Qwen explicitly blocks resume, selectors and HTTP MCP. Profiles cover exact researched versions only and are labelled `source_profile`, never verified. All agents report limited visibility and unknown authentication. No account isolation or migration strategy has been verified; the public APIs return unsupported. The separate accounts integration must connect its ownership and enforce those results before offering additional accounts.

Generic agents obtain models from an already authorized session. Listing and refreshing their model catalog cannot spawn a process or create an empty session. Cache generations include agent, installation, instance, profile and login revision. Native providers and the existing Cursor/Antigravity profiles retain their defaults.

SDK 1.7.0 public constants are adopted, while the live transport remains provider-kit's bounded `JsonRpcPeer`. Its pending/handler/write bounds and lenient session updates cannot yet be reproduced using the stable SDK Connection's public API. See [ADR 0044](../../docs/adr/0044-acp-agent-registry.md).

## Budgets and verification

Catalog: 4 MiB response, 2,048 entries, 64 KiB per entry, 24-hour TTL, one 10-second refresh, 50 rows per page. Icons remain URLs and are not fetched. Local inventory: 512 installations, 16 MiB persisted file. Plans: 16; retained intent results: 128; installation: one active, five-minute deadline, 128 MiB download, 4 MiB manager output. ACP transport: 256 outgoing requests, 128 incoming handler lifetimes, 16 MiB frames, 32 MiB queued/in-flight writes, 4,096 explicit ID reservations. Session input: 64 requests/4 MiB. MCP bridge: 64 requests, 64 KiB input lines, 256 KiB replies, 8 MiB writes, 120-second request deadline including output drain.

Behavior tests and benchmark definitions are written but unexecuted under the owner's merge-only rule. [Verification and mutation plan](VERIFICATION.md) records required merge evidence. No provider sessions or recordings were run. [Recording plan](../../docs/research/providers/acp-registry-recording-plan.md) needs a separate owner request.

Installation persistence is a noncancellable commit phase. Cancellation returns `cancelled: false` once that phase starts. If rename succeeded but directory durability confirmation failed, the artifact remains registered and the result includes `durability: "uncertain"`. Custom `InventoryStorage.save` implementations must throw the public `CommittedWriteError` for errors after publication.

Main's accounts service now registers ACP CLI defaults on the first authorized thread. It retains agent, installation and instance references, profile/version metadata and login revisions. Default instances retain CLI-owned homes and credentials; they do not claim isolated additional accounts. `AccountService.acpEnvironment` supplies account generations, and its local `loginAcp` API uses `AgentRegistry.resolveLogin` for reviewed commands with inherited terminal I/O. Unknown profiles return unsupported. No ACP authenticate call or remote login flow is added.

Bridge child sessions use bilateral canonical negotiation and the exact-version metadata fallback documented by the bridges. They retain source-profile and limited-visibility labels; fixture recording and owner architecture acceptance remain separate gates.
