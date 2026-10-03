# Integration train 2

## Merge decisions

- #44: retain train 1's daemon options and service/resource registries. Register files through daemon/socket factories; register relay transport startup at the authenticated transport boundary. Socket services now have authentication and binary hooks. Preserve preview, diagnostics, notifications, models, engine, settings, context, review and history.
- #44: use bounded fragmented relay binary messages and retain the preview `receiveBinary` interface over the same framing. Both consumers share encryption, rekeying and queue bounds.
- #44: retain indexed text-stream range reads and paging while adding raw byte export and blob/output metadata. Preserve both workspace-change and update-blocker indexes.
- Keep package dependencies, protocol exports and NOTICE attribution from every head. Regenerate lockfiles from the current integration branch with `bun install`.
- Replace incoming process manifests with `.process.test.ts` filenames. Preserve all-package externalization in the process fixture build so native bindings, CommonJS dependencies and worker URLs resolve normally.

Each feature merge is typechecked before its commit. Full runtime validation follows the final merge.

- #46: move catalog startup and socket requests to service factories. Keep trusted runtime/execution event subscriptions and shutdown cancellation. Retain the stronger typed workspace lookup instead of coercing database values to strings. Migrate command I/O suites by filename.
- #25: register the account registry and bounded authenticated account requests as services. Preserve CLI argument normalization and account subcommands. Single-provider discovery now owns the shared probe logic, with train 1's Antigravity read-only probe retained. Keep filename-based test projects and classify account I/O tests.

## I7 provider session composition

Account-aware daemon adapters now bind the selected environment before native discovery/spawning. Claude, Codex and ACP session shells honor `SessionContext.env`; OpenCode gives each assigned session an owned isolated server so accounts cannot share a provider process. Adapters admit immutable bounded frame payloads before account forwarding. Engine metadata stores instance identity atomically with the native session ID and supplies it on resume. Existing train-1 databases gain the instance column without discarding snapshots. Unassigned legacy resumes fail closed when account binding is enabled, since their originating home cannot be inferred safely.

Binding is evaluated at each launch, so accounts registered after daemon startup also receive isolated environments. Rebinding an injected adapter registry starts from its original adapters instead of retaining a closed account owner.

A daemon restart regression uses a real Node child at the provider boundary to observe the selected home and masked synthetic ambient API key. It checks successful turns before and after restart and pinned native/instance resume identity. No installed provider is prompted.

I7 remains open for model-role resolution, MCP leases, plugin launch projection, native message-context projection, native slash execution/action dispatch and automatic adapter catalog event feeds, including command-home discovery after dynamic account registration. Their standalone request services remain available; this train does not claim those execution paths are composed.

- #47: preserve usage replay/deletion markers and add search ingestion/deletion in the same transactions. Preserve text-stream and file-export range reads. Register search sockets through the registry, track query shutdown tasks and recheck read authority before both success and error replies. Resource disposal now awaits search workers and store close. Migrate search I/O suites by filename.
- #29: register screen ownership and authenticated human screen connections through service registries. Share simulator admission per server registry, preserve revocation cleanup and frame backpressure, and track requests through shutdown. Keep train 1's pre-readline raw output/aggregate supervisor; adapt the helper's output-limit callback to it and remove the duplicate line limiter. Screen/native process suites register by filename. Search now accepts agentless canonical items with nullable index identity; fixtures explicitly validate IDs when emitting agent deltas.

- #50: retain #29's shared HelperHost and coalesced Pixels leases; add Windows helper-owned IPC, generation retirement, portable input and thread+agent scoped MCP delegation. Normalize platform UI trees at the shared semantic boundary and retain native error codes. Capture stops before publication; shutdown joins all cleanup and preserves native/publication errors. Remove superseded parallel session/line-reader implementations. The oversized-command fixture previously encoded only 49 KiB; increase its stimulus beyond the 64 KiB cap without changing its assertion. Focused Windows lifecycle/MCP checks: 19 passing. Native Windows execution remains unverified on this macOS runner.

- #52: retain the shared service/host/control implementation and add Linux backend selection, private Unix IPC, negotiation, updated portal capabilities after start, bounded AT-SPI result normalization, named input and consent-aware capture release. Preserve #29's stronger admin-only screen boundary for all platforms; adapt Linux callers and tests to the common API. Remove its duplicated control and authorization modules. Linux fake-helper checks: 7 passing. Real X11/Wayland and Rust platform checks remain host-specific follow-ups.

- #41: union MCP exports and keep native postinstall hooks. Expand the docs catalog to every protocol entry point; annotate new semantic refinements. Support source-declared structural contracts for guarded opaque-ID and UI decoders without allowing unannotated transforms. Export recursive shared definitions and document native PTY bytes as binary with a JSON schema rejecting all JSON. Keep independent property validation and deterministic ordering; regenerate the complete reference after final schemas.

## Full-gate fixes

- Index canonical `artifact` items, including artifacts with no agent, and keep their path/MIME searchable.
- Retain default command homes for providers without account overrides; resolve a preview account before a first turn and use the persisted assignment afterward. Rank equal fuzzy matches by command name before opaque source IDs; usage boosts remain intact.
- Apply screen enable/approval operations in the authenticated bridge. Join startup cancellation before removing sessions so observers see confirmed termination. Disable waits for capture shutdown, closes the host, then joins stalled artifact publication.
- Keep UI-budget fixtures below the transport byte limit so they exercise node/depth budgets. Use valid UI queries and update unsupported-platform assertions now that Linux is supported. Existing bounds assertions remain intact.
- Preserve train 1's unframed binary supervision and expose bounded text bytes separately for callers that own decoding. The readline facade shares that text owner. Both contracts retain their original byte/termination assertions; line-limit diagnostics include the numeric budget. Terminate before invoking observer callbacks.
- Canonicalize trusted artifact roots at registration, while preserving the workspace identity used for mutation event fan-out. Dispose the file producer before startup operations that can fail.
- Keep cancellation ordering assertions and let that test's client receive change messages instead of silently collecting them separately. Hoist metrics-request schemas in isolated transfer fixtures and validate archive chunks without allocating a schema per chunk; 200 MiB memory assertions remain unchanged.
- Externalize Koffi and stage its pinned native optional dependency for the release target. Unify commands/files on Koffi 3.3.2 while retaining incoming NOTICE paragraphs and documenting the current accepted version. Bundle file blob/rename and search-query workers and rewrite their runtime URLs, so standalone releases do not depend on checkout paths.
