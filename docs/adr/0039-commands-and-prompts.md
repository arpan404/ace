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
runtime source. Session shutdown must clear its runtime source.

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
actual execution, not merely after previewing a resolution.

## Security and failure behavior

YAML and JSONC parse into Zod schemas. Unknown provider fields remain in raw
metadata. Malformed files produce diagnostics; other files remain usable. No
shell interpolation, environment interpolation, provider login or CLI calls
occur in discovery or planning. Native plans leave provider context injections
to the provider. Discovery rejects symlinks, bounds file bytes and directory
entries, and watches only registered roots. Wire schemas cap arguments, query
length and result counts. Diagnostics use logical source labels.

## Performance

Each file is an independent source. A watcher event invalidates that path only;
rename updates reconcile that subtree. Debounce uses a bounded pending set and
falls back to a bounded root reconciliation on overflow or unnamed events.
Missing roots are watched through their nearest existing ancestor.
A repeated real-filesystem probe demonstrated missing native notifications,
even with a single watcher. A round-robin recovery ring therefore checks at
most 32 path metadata records per 250 ms tick and queues only changed paths.
At most 4,160 paths are retained; slot reuse preserves fairness under churn.
Only one recovery batch can run at a time. Tests inject notification loss and
a controlled scheduler while retaining real filesystem I/O. See the
[Node watch caveats](https://nodejs.org/api/fs.html#caveats). File reads
use a fixed byte limit, never unbounded `readFile`. A catalog admits at most 8 MiB of estimated definition data. Native directory
watches are capped at 128 per context and never recurse over an entire home.
Contexts with runtime sources stay pinned until their sessions clear them.
Source, command, runtime,
usage, context, watcher and traversal counts have admission limits. Disposal
closes watchers and drains pending work. Search scans the bounded active catalog
and keeps only a bounded top result set in a heap, O(n log k) work. A non-gating benchmark measures source
replacement, resolution and ranking with process RSS.

## Tests

Public API tests use synthetic files in real provider formats and recorded
Claude init frames. They cover diagnostic isolation, argument defaults/types,
escaping, non-recursive replacement, native and expanded plans, instance/scope
precedence, runtime replacement, fuzzy usage ranking and resource limits.
Filesystem tests use temporary directories and event-driven watcher completion,
without synchronization sleeps. WebSocket tests cover authenticated list and
resolve, thread context and remote read scopes. At least eight production-code
mutations must each fail a behavioral test before delivery.
