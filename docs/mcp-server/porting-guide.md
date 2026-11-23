# Porting the MCP server to Rust

For the builders who move `@ace/mcp-server` into `native/daemon` (`ace-mcp`) and the stdio bridge
into the Rust `ace` binary, one work item each. Read
[ADR 0225](../adr/0225-devices-screens-automations-and-the-mcp-server-move-to-rust.md) and
[behaviour.md](behaviour.md) first: the contract there is what you keep, and behaviour.md §5 lists
every test file by class. The [devices porting guide](../devices/porting-guide.md)'s rules for
every item apply here unchanged; this guide adds what is particular to the MCP server.

Branch from `ace/daemon-rust-rewrite` once the item's needs are merged, one branch per item
(`ace/rust-mcp-<item>`).

## Rules particular to the MCP server

1. **Our own MCP layer on `hyper`, not `rmcp`** (ADR 0225 §3: `rmcp`'s model is
   `serde_json::Map` and `String`, which drop lone surrogates and re-spell numbers). Write
   JSON-RPC and the MCP methods (`initialize`, `ping`, `tools/list`, `tools/call`,
   `resources/list`, `resources/read`, notifications, progress, cancellation) from the
   specification for 2026-07-28 and the 2025 versions ace serves today. The MCP TypeScript SDK may
   be read to learn which interfaces exist; its code is not copied or paraphrased (AGENTS.md,
   clean-room rule). Wherever a test pins the SDK's bytes (a JSON-RPC error code or message, a
   header, an SSE frame), produce those bytes; where nothing pins them, follow the specification.
2. **Every response body is `ace-json`.** Tool results' `content[].text` is the exact string the
   output schema's checked value stringifies to; `structuredContent`, descriptors and resources
   are written with `ace-json` in their schema's key order; arguments and results are `JsString`
   throughout.
3. **Descriptors and words come from the catalog (M1), never retyped.** The canonical copy is
   language-neutral JSON under `native/daemon/catalog/` (ADR 0225 safeguard 3), read by the
   TypeScript and by Rust: each tool's descriptor as `tools/list` serves it (`inputSchema` and
   `outputSchema` with ace's advertising rules, `advertised-schema.ts`, `schema-unions.ts`;
   annotations and `_meta`, `registry.ts:333`–`:380`), the `PublicToolError` catalog
   (`public-error.ts`), `aceInstructions` and guide topics (`status.ts`), session guidance
   (`session-guidance.ts`), control hints (`control-hints.ts`), listing headers (`toolsets.ts`).
4. **Input is Zod's until a family proves otherwise** (ADR 0225 §4.2). For a JavaScript tool, the
   `JsTool` bridge runs the tool's own `parseToolArguments`, handler and output check in TypeScript.
   For a Rust family, the accept-or-reject decision comes from its typed decoder only where its (a)
   files pin rejection cases; otherwise from the Zod port. The words of a rejection always come
   from the Zod port.
5. **Same numbers** (behaviour.md §3): 1,024 leases, 256-bit hex bearers stored by digest, 1,024
   calls and 256 per thread, 64 KiB input by default, 256 KiB structured and 12 MiB rich results,
   1 MiB model images, one deadline from a call's start up to 660 s, 30 s progress beats, 2,048
   requests, 8 KiB headers, 30 s request and 10 s header timeouts, notification streams bounded per
   lease and 512 in all, `maxRequestBodyBytes`.
6. **The call order is contract**: `session_ended`, `tool_unavailable`, `host_policy_refused`,
   `calls_limit`, `cancelled`, then the host's `actAs` hook, then the tool; a slot is taken before
   anything is awaited; an uncooperative backend keeps its slot (`registry.ts:460`–`:604`).
7. **Permissions are the provider's**: annotations only; ace hides groups that are off and never
   adds an approval.
8. **Never print a bearer**; captures redact it (`redactMcpCredential`, owned by the adapters,
   ADR 0223 E3).
9. **Measure** with `HOME=$(mktemp -d) bun apps/daemon/bench/mcp-requests.ts` (add
   `--cpu-prof-md` for where a call's time goes) and `bun packages/mcp-server/bench/dispatch.ts`,
   switch off and on.

## Files per item

| Item | Rust (yours)                                                                                        | Binding (yours)                                   | TypeScript shell (yours)                                                                       | Switch                      |
| ---- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------- |
| M1   | `native/daemon/catalog/{tools,errors,guidance,listing}.json`, `ace-mcp/src/catalog.rs`              | none                                              | `scripts/export-catalog.ts` (once), `check:catalog-listing`, `check:catalog-text`              | none                        |
| M2   | `ace-mcp/src/{http,jsonrpc,sessions,legacy,streams,auth,registry,listing,calls,budgets,js_tool}.rs` | `ace-daemon-node/src/mcp/{mod,server,js_tool}.rs` | `packages/mcp-server/src/native-server.ts` (the switch line in `startMcpServer`, `http.ts:95`) | `ACE_MCP=native`            |
| M3   | `ace-mcp/src/{records,awareness,brief,digest,roles,guidance,search,availability}.rs`                | `ace-daemon-node/src/mcp/awareness.rs`            | the switch lines in `apps/daemon/src/tool-result-mcp.ts`, `mcp-awareness.ts`, `mcp.ts`         | `ACE_MCP_CALLS=native`      |
| M4   | the family owner's crate, `tools.rs`                                                                | `ace-daemon-node/src/tools/<family>.rs`           | the family line in its toolkit                                                                 | `ACE_NATIVE_TOOLS=<family>` |
| M5   | `native/cli/src/mcp_stdio.rs` (the `ace` binary, ADR 0221)                                          | none                                              | `acpStdioInjection`'s command (`injection.ts:216`)                                             | `ACE_MCP_STDIO=native`      |

## M1: the canonical catalog (needs nothing)

1. **Export once.** `scripts/export-catalog.ts` builds every toolkit's registry the way
   `tools/protocol-docs/src/catalog.ts` and `apps/daemon/bench/tool-list.ts` already do (fake
   ports, no effects) and writes, as `JSON.stringify` writes them: each tool's descriptor, the
   public error catalog, the instructions, guide topics, session guidance, control hints and
   listing headers, into `native/daemon/catalog/`. The area guides add their own files
   (`devices.json`, `screen.json`, `automations.json`) the same way.
2. **The TypeScript reads its words from the catalog**: `public-error.ts`'s messages and next
   steps, `status.ts`'s instructions, `session-guidance.ts`, `control-hints.ts` and the listing
   headers import the JSON (`with { type: "json" }`) instead of holding literals. Behaviour is
   unchanged, which the (a) files prove; descriptors stay built from Zod while the TypeScript
   runs, and the check below holds them to the catalog.
3. **Rust embeds the same files** (`include_str!`, parsed with `ace-json`, `ace-mcp/src/catalog.rs`).
4. **Two checks in `check:daemon-native`**: `check:catalog-listing` starts a daemon on an empty
   temporary `HOME` and `ACE_HOME` (no provider) and compares each built backend's live
   `tools/list`, byte for byte, with `tools.json`, and `z.toJSONSchema` of every live registration
   with its entry; `check:catalog-text` renders every public error code and every refusal through
   each backend's live path (`toolFailure` in TypeScript, the addon in Rust) and compares the
   bytes. A tool added or a word changed means editing the catalog, and both sides follow.

- Proof: both checks pass; `advertised-schema`, `tool-guidance.process`, `status`,
  `session-guidance`, `actionable-errors`, `agent-errors` run unchanged.

## M2: the server and registry (needs M1, `ACE_STORE=native`)

`startMcpServer` (`http.ts:95`) returns the same object (`url`, `handleHttp`, `serve`,
`credentials`, `awareness`, `toolsChanged`, `close`) backed by the native server. `ToolRegistry`
and `CredentialRegistry` keep their classes; a toolkit's `register` still runs in TypeScript, and
each registration becomes a `JsTool` entry the Rust registry calls back on the JS thread (about
2 µs a call). `handleHttp` (requests that arrive on the daemon's own port) and `serve` (the
outside endpoint, ADR 0122) stream request bodies in and response bytes and SSE frames out
through the binding; `external-mcp` keeps building on them unchanged. The host hooks
(`admit`, `actAs`, `callSignal`, `observeCall`, `reportFailure`, availability) stay ports until M3.

| TypeScript replaced (`packages/mcp-server/src/`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Proof: (a) files                                                                                                                                                                                                                                                                                                                                                                | (b) cases to move |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `http`, `registry`, `credentials`, `public-error` (the class and its detail sanitizing over `JsString` units; the catalog comes from M1), `legacy-sessions`, `principal-bus`, `progress-heartbeat`, `scope-challenge`, `json-budget`, `result-budgets`, `timeouts`, `tool-failure`, `tool-names`, `toolsets`, `claude-tool-search`, `meta-tools`, `tool-delivery`, `act-within`, `action-target`, `actions`, `read-only-tools`, `waits`, `content-tools`, `model-image`, `model-image-runtime`, `image-geometry`, `context-tool`, `builtins`, `toolkits`, `catalog` | all 36 of `packages/mcp-server/src/` (a); daemon `mcp.process`, `mcp-tools.process`, `mcp-tools-find.process`, `mcp-discovery.process`, `mcp-codex-discovery.process`, `mcp-controls.server.process`, `mcp-upgrade`, `mcp-agent-budget.process`, `mcp-catalogue-budget.process`, `opencode-mcp.process`, `provider-mcp.process`; the 21 `external-mcp` files with the switch on | `codex-guidance`  |

`actions` and `action-target` (the approval target a provider shows) are also called by the
engine's approvals (ADR 0223 E5.7): one implementation, in `ace-mcp`, which `ace-engine` depends
on once M2 lands. Model images go through ace-media's image process. Windows: M2 passes in the
Windows VM before default-on.

## M3: the lean call (needs M2)

The per-call store work that took about 55% of a call's CPU (ADR 0225, finding 1), designed out:

- **Call records keep the start write and its whole correlation transaction.** The start row is
  not bookkeeping: at the start of every call, inside one transaction, `observeCall`
  (`tool-result-mcp.ts:175`–`:226`) finds the provider's tool item this call belongs to (`prior`,
  `ace_tools` rows of the same agent, name and arguments since the lease began, within 90 s, not
  yet bound, at most 2), detects an identical call still running in the same session
  (`finished IS NULL`) and then clears every unbound row's `bound_id` so an ambiguous pair binds
  to nothing, and inserts the row with `bound_id` set to the one prior item, or `''` when the
  binding is ambiguous. The item-event side (`:150`–`:172`, `correlate`) binds results to items
  that arrive after the call. M3 moves that whole transaction to Rust unchanged, on the main
  connection, before the tool runs, with the same statements, windows and limits (cached
  prepared statements; no extra reads). The finish write (`:256`–`:280`: result, images,
  notice) keeps its own transaction, in the writer's batch once ADR 0222 phase 5 has landed. The
  savings come from the next two items, not from dropping a write.
- **The change digest**: each session's facts are held and updated from the store's published
  events (threads, notes, requests, delegates), so `changes` and `guidance` compare held facts
  instead of reading them per call (`awareness.ts:61`–`:118`); `renderBrief`, `renderDigest` and
  `renderRoles` are ported with `JsString` and their character limits in UTF-16 units.
- **Availability**: the status reader's answer is cached per caller and invalidated by the
  group and settings events, instead of read for every call and every listing
  (`http.ts:100`–`:109`).
- `tool-search` (the ranking behind `tools_find`) moves here.
- `argument-issues` and `parseToolArguments`' wording stay TypeScript behind the Zod port (ADR 0225 §4.2); `schema-unions` is used only by M1's generator.

| TypeScript replaced                                                                                                                                                 | Proof: (a) files                                                                                                                                                                                                                                                                                               | (b) cases to move |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `awareness`, `brief`, `changes`, `roles`, `session-guidance`, `status`, `tool-search`; daemon `tool-result-mcp`, `tool-result-content`, `mcp-awareness`, `mcp-data` | `brief`, `roles`, `status`, `session-guidance`, `session-brief.process`, `thread-read-view`, `actionable-errors`; daemon `mcp-awareness.process`, `mcp-guidance.process`, `mcp-roles.process`, `mcp-status-groups.process`, `claude-mcp-privacy.process`, `measurement-step.process`, `mcp-tools-find.process` | `tool-search`     |

Measure with `bench/mcp-requests.ts` and its CPU profile: the share of a call outside the tool's
own work must fall, and nothing in the (a) files may change. Also run, switch on, the files that
pin the correlation: `tool-result-mcp` binding through daemon `measurement-step.process`,
`agent-computer-journey.process` (screen results bound to their items) and the item-event path in
`mcp.process`. Cross-mode: the daemon files above that restart, both ways (a row started by one
backend is finished or correlated by the other).

## M4: tool families (each needs M2 and its owner)

A family's handlers move with their owner; registration, schemas, titles, risk classes and words
don't change. Order: agent-control's (behind `AgentControlPort`, `control-tool.ts:15`, when
agent-control's ADR lands), then devices (devices D5), computer and screen (screen S4),
automations (automations A4), and the rest as their owners move.

| Family                            | TypeScript replaced (`packages/mcp-server/src/`)                                                                      | Proof: (a) files                                                                                                                      | Owner first                   |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `agent-control`                   | `agent-control`, `agent-tools`, `thread-tools`, `thread-control-tool`, `thread-view`, `control-tool`, `control-hints` | `agent-errors`, `actionable-errors`, `thread-read-view`, `lifetime.process`; daemon `mcp-tools.process` and agent-control's (a) files | agent-control's Rust port     |
| `automations`                     | `automation-tools`                                                                                                    | automations A4                                                                                                                        | automations A1                |
| `guide`, `knowledge`, `notify`    | `guide-tools`, `knowledge-tools`, `builtins` (notify)                                                                 | `tool-guidance.process`, `session-brief.process`; daemon `mcp-guidance.process`                                                       | M3 (they read the same facts) |
| `html`, `image`, `suit`, `market` | `html-tools`, `image-tools`, `suit-tools`, `suit-previews`, `suit-port`, `market-tools`, `market-verbs`               | `html-tools`, `content`, `suit-tools`, `market-tools`; daemon `cli` market tests                                                      | their publication services    |

`market-verbs` is also used by the daemon's market CLI (`apps/daemon/src/cli/market/actions.ts`):
one implementation, moved with the family.

## M5: the stdio bridge (needs M2 and ADR 0221's CLI)

Replaces `stdio-bridge` and `stdio-entry`. Today a stdio-only client (ACP agents) spawns
`stdio-entry.ts` in Bun (`injection.ts:216`–`:220`). In Rust it is a subcommand of the `ace`
binary, and it keeps **both protocol paths** of `stdio-bridge.ts`, not a byte pipe:

1. **Requests go stateless over 2025 HTTP** (`:87`–`:150`): each stdin line is parsed as a
   JSON-RPC message (a malformed line fails the bridge, as `Message.parse` does), POSTed alone to
   the endpoint with `MCP-Protocol-Version: 2025-11-25`, `Accept: application/json,
text/event-stream`, the bearer, the listing headers and `redirect: error`. A notification, or
   a `202`, writes nothing back. A JSON reply is written as is; for an SSE reply the bridge reads
   events until **the one whose `id` matches the request** and writes only that one, dropping
   other events. Each written line is the reply value as `JSON.stringify` writes it, which
   `ace-json` reproduces from the parsed value.
2. **Notifications come over a separate 2026-07-28 subscription** (`:60`–`:93`): on the first
   `notifications/initialized` or `tools/list`, the bridge opens one session pinned to
   `2026-07-28` with the bearer and listing headers, and, when the server's capabilities say
   `tools.listChanged`, listens; each `notifications/tools/list_changed` it receives is written to
   stdout. A failure to open it is ignored, as today (`listen().catch`).
3. **Cancellation and deadlines per request**: a `notifications/cancelled` aborts the in-flight
   request with that `requestId` (`:91`–`:94`); a duplicate request id fails the bridge
   (`:97`); a request's own deadline (`maxToolTimeoutMs` for `tools/call`, else 120 s)
   aborts only that request and leaves the connection for the next (`:103`–`:110`).
4. **Budgets**: `maxBridgeResponseBytes` per reply and `maxBridgeQueuedBytes` across replies
   (`result-budgets.ts`), a bounded writer with the same backpressure, and the same close: a
   failure aborts the lifetime, closes the writer and destroys stdin.

The server side (M2) therefore keeps serving both: stateless 2025 POSTs with JSON or SSE replies,
and 2026-07-28 sessions with listen streams and `list_changed`.

- (a): `stdio-bridge.process`, `stdio-results.process`, `acp-listing.process`,
  `list-changed.process`, `notification-streams.process`; the ACP adapter's session (a) files that
  use the bridge; each with `ACE_MCP` off and on too, since the bridge and server switch apart.
- Measure `bench/stdio.ts`, off and on.

## Not part of this port

The injection helpers (`injection`, `private-config`) and MCP discovery (`discovery`,
`discovery-apis`) are the adapters': each Rust adapter session builds its own provider's
injection and reads its own provider's configuration in ADR 0223 E3. `index`,
`market-verbs`' export path and `suit-port` stay as the package's TypeScript surface while any
TypeScript caller remains.

## When you are done

- Every (a) file of your item passes alone with the switch on and off; your (b) cases pass in
  `cargo test -p ace-mcp`; `check:daemon-native` passes; the cross-mode list passes both ways.
- Report: the files run and their results, `bench/mcp-requests.ts` (with a profile) and
  `dispatch.ts` off and on, anything in behaviour.md that turned out wrong (with the code that
  shows it), anything you kept TypeScript because it couldn't be reproduced exactly, and the one
  test you added, if any.
