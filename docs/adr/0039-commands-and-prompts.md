# 0039: Unified commands and prompt library

Date: 2026-10-02. Status: accepted.

## Context

The competitor inventories in `/tmp/ace-orch/research-t3code.md` and
`research-competitors.md` describe provider passthrough, built-in palettes and
skills. They do not establish a shared, typed prompt library across providers
and accounts. ace needs one backend catalog for future desktop, web and mobile
clients. Names alone cannot identify commands across homes or providers.

Provider research and the installed `claude --help`, `codex --help` and
`opencode --help` were checked without sending prompts. Claude's recorded init
contains `slash_commands`, `skills` and `terminal_slash_commands`. Codex research
finds no app-server slash catalog; its prompts expand in the client. ACP replaces
its session catalog through `available_commands_update`. OpenCode commands can
carry agent, model and subtask behavior that plain expansion would lose.

Primary format references:

- [Claude skills](https://code.claude.com/docs/en/skills)
- [Codex custom prompts](https://developers.openai.com/codex/custom-prompts)
- [OpenCode commands](https://opencode.ai/docs/commands/)
- [ACP slash commands](https://agentclientprotocol.com/protocol/v1/slash-commands)

## Decision

`@ace/commands` owns parsers, argument validation, pure execution planning,
fuzzy ranking, a bounded incremental catalog and a filesystem shell. Protocol
schemas live in a new `command-library.ts`; adapters depend on the public
`updateRuntime` port, not daemon internals. Updates replace only that session's
runtime source. Session shutdown must clear its runtime source. Clearing cancels queued and in-flight updates using bounded per-request tokens, so an update cannot repin a closed session. No permanent session tombstones are retained.

Discovery accepts explicit provider instance IDs and configuration roots. The
active thread selects one instance, preventing another account's commands from
leaking into it. Project definitions beat user definitions. Runtime definitions
beat disk definitions of the same provider command. Claude skills beat legacy
commands at the same scope. ace commands, provider commands and library snippets
have separate namespaces and stable IDs, so collisions remain selectable.

Claude commands and skills pass through natively on Claude, preserving its
permissions and dynamic context. Terminal-only commands are unavailable.
Consumers submit prompt plans verbatim and native plans through the provider
command transport, so slash text inside a snippet cannot select a command.
OpenCode commands pass through with their metadata. ACP commands pass through
only on their originating provider. Codex file prompts expand locally, including
named and positional arguments. File-only project Codex prompts are an ace
extension, since Codex documents only top-level user prompts. No arbitrary
cross-provider expansion of provider files is attempted.

Library markdown at `<ace home>/prompts/*.md` and `.ace/prompts/*.md` has YAML
frontmatter containing `name`, `description`, `provider: any | ProviderKind` and
an `arguments` map. Arguments declare `type: string | number | boolean`,
`required` and an optional typed `default`. `{{name}}` substitutes once;
`\{{name}}` is literal. Values are never recursively expanded. Missing required,
unknown and incorrectly typed arguments return typed errors. Provider dollar
syntax is interpreted only for provider files, keeping library prose literal.

Built-ins `/review`, `/fork`, `/checkpoint`, `/conductor` and `/model` resolve to
ace action plans. This package does not execute those actions. Consumers route
supported actions through their owning modules and reject unavailable actions.

## Protocol and wire additions

Authenticated request messages `commands.list{requestId,threadId,query,limit}`
and `commands.resolve{requestId,threadId,commandId,arguments,positional}` return
`commands.list.result` and `commands.resolve.result`. List results contain
metadata and diagnostics, never template bodies or configuration paths. Resolve
returns a discriminated native, prompt or ace plan, or a typed error. Requests
require read scope; resolving does not send or execute anything. Provider and
workspace context come from the daemon's thread registry, never client paths.

The daemon accepts an injectable command service for adapters and tests. Its
startup service lazily opens bounded per-workspace catalogs using registered
workspace paths and default CLI homes. Explicit instance registration is the
integration point for the account workstream. These requests do not write
command receipts or agent state. Usage ranking is recorded explicitly after
actual execution, not merely after previewing a resolution. Daemon startup accepts
registered command instances, a trusted thread-to-instance selector and a local
engine event source. `commands.runtime`, `session.closed` and `command.executed`
events connect adapters and execution dispatch to the library. This local port
is not a wire mutation or a provider execution API.

## Security and failure behavior

YAML and JSONC parse into Zod schemas. Unknown provider fields remain in raw
metadata. Malformed files produce diagnostics; other files remain usable. No
shell interpolation, environment interpolation, provider login or CLI calls
occur in discovery or planning. Native plans leave provider context injections
to the provider. Discovery opens the trusted root and each descendant relative to a pinned
directory descriptor, with `O_NOFOLLOW` on every component and `O_CLOEXEC` on
acquired descriptors. Files are read from the descriptor opened beneath that
root. Replacing an ancestor pathname cannot redirect the read to another tree.
Pinned anchors live for one catalog context; changing the registered workspace
or home requires closing and reopening that context.

Node's public filesystem API does not expose `openat` or `fdopendir`.
The filesystem shell uses Koffi 3.1.0, MIT licensed, to call those OS interfaces
asynchronously. The binding targets 64-bit macOS and Linux on x64/arm64, uses
their documented dirent ABIs, and validates native results and entry names.
Unsupported native bindings fail closed. Other platforms require a secure I/O
implementation; there is no pathname-only fallback. No native implementation
code was copied. See [openat rationale](https://man7.org/linux/man-pages/man2/open.2.html)
and [Koffi asynchronous calls](https://koffi.dev/load#asynchronous-calls).

Discovery bounds file bytes and directory entries and watches registered roots. Wire schemas cap arguments, query
length and result counts. Diagnostics use logical source labels.

## Performance

Each file is an independent source. Named watcher events inspect that path.
Cached child metadata versions prevent rereading unchanged files. An unnamed
event or changed directory metadata enumerates only the affected directory;
surviving subdirectories are not traversed again. Names require O(directory
entries) work when the OS supplies no change list, but file body reads remain
O(changed files). Generation marks identify removed children without copying
child sets. Directory enumeration and subtree removal each advance one entry
per work unit.

Native notifications are platform-dependent and can be missed. Each recovery
tick checks at most 32 metadata records and performs at most 32 discovery work
units. The recovery ring retains at most 4,160 paths and preserves fairness
under churn. Native notification drains also advance in 32-unit event-loop
turns. Explicit `flush` and initial `start` drain the bounded queue to completion.
Tests can inject notification loss, scheduling and I/O timing while retaining
real filesystem operations. See the [Node watch caveats](https://nodejs.org/api/fs.html#caveats).

Limits include 4,096 discovery nodes, 8,192 queued jobs, 32 open directory cursors,
32 pinned anchors, 128 native watchers and 256 pending invalidations per context.
Files use a 64 KiB read limit. The catalog admits 8 MiB of estimated definitions;
usage, runtime sources, service requests and contexts have independent caps.
A local engine connection tracks at most 1,024 pending or active sessions.
Startup is idempotent. Shutdown stops admission, drains startup and work batches,
then disposes directory cursors, watchers, timers and trusted-root descriptors.

Search scans the bounded active catalog and retains a bounded heap of the best
results, O(n log k). Public discovery metrics report successful body reads,
bytes, metadata checks, recovery checks and enumerated entries. A non-gating
benchmark measures source replacement, resolution, ranking, metadata recovery,
file refresh, directory churn and process RSS. Final measurements need run at merge.

## Tests

Public API tests use synthetic files in real provider formats and recorded
Claude init frames. They cover diagnostic isolation, argument defaults/types,
escaping, non-recursive replacement, native and expanded plans, instance/scope
precedence, runtime replacement, fuzzy usage ranking and resource limits.
Filesystem tests use temporary directories and event-driven watcher completion,
without synchronization sleeps. WebSocket tests cover authenticated list and
resolve, thread context and remote read scopes. Mutation cases identify which
behaviors the tests are designed to guard. Under the repository owner's current
policy, tests, mutation runs and benchmark execution happen at merge time;
runtime validation needs run at merge. Delivery uses formatting, lint, size
and type checks only.
