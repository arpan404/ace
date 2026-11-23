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
3. **Descriptors and words are generated (M1), never retyped.** `inputSchema` and
   `outputSchema` from `z.toJSONSchema` with ace's advertising rules (`advertised-schema.ts`,
   `schema-unions.ts`), annotations and `_meta` (`registry.ts:331`–`:380`), the `PublicToolError`
   catalog (`public-error.ts`), `aceInstructions` and guide topics (`status.ts`), session guidance
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
| M1   | `ace-mcp/generated/{tools,errors,guidance,listing}.json`, `ace-mcp/src/generated.rs`                | none                                              | `scripts/generate-rust-mcp.ts`, a step in `check:daemon-native`                                | none                        |
| M2   | `ace-mcp/src/{http,jsonrpc,sessions,legacy,streams,auth,registry,listing,calls,budgets,js_tool}.rs` | `ace-daemon-node/src/mcp/{mod,server,js_tool}.rs` | `packages/mcp-server/src/native-server.ts` (the switch line in `startMcpServer`, `http.ts:95`) | `ACE_MCP=native`            |
| M3   | `ace-mcp/src/{records,awareness,brief,digest,roles,guidance,search,availability}.rs`                | `ace-daemon-node/src/mcp/awareness.rs`            | the switch lines in `apps/daemon/src/tool-result-mcp.ts`, `mcp-awareness.ts`, `mcp.ts`         | `ACE_MCP_CALLS=native`      |
| M4   | the family owner's crate, `tools.rs`                                                                | `ace-daemon-node/src/tools/<family>.rs`           | the family line in its toolkit                                                                 | `ACE_NATIVE_TOOLS=<family>` |
| M5   | `native/cli/src/mcp_stdio.rs` (the `ace` binary, ADR 0221)                                          | none                                              | `acpStdioInjection`'s command (`injection.ts:216`)                                             | `ACE_MCP_STDIO=native`      |

## M1: generated tables (needs nothing)

`scripts/generate-rust-mcp.ts` builds every toolkit's registry the way
`tools/protocol-docs/src/catalog.ts` and `apps/daemon/bench/tool-list.ts` already do (fake ports,
no effects), and writes each tool's descriptor as `JSON.stringify` writes it, the public error
catalog, the instructions, guide topics, session guidance, control hints and listing headers.
`check:daemon-native` regenerates and fails on a diff. No runtime change, no switch.

- Proof: `check:daemon-native`; `advertised-schema`, `tool-guidance.process`, `status`,
  `session-guidance` run unchanged.

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

- **Call records**: a running call's record lives in the registry's in-flight table (the
  overlap rule of `tool-result-mcp.ts:201`–`:211` reads it there) and is written once, when the
  call ends, with its result, images and notice, through `ace-store` (in the writer's batch once
  ADR 0222 phase 5 has landed). If a reader of `ace_results.finished IS NULL` across a restart
  is found, the start row stays, written through the same batch, and the report says so (ADR 0225
  question 5).
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
own work must fall, and nothing in the (a) files may change. Cross-mode: the daemon files above
that restart, both ways (call records).

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

Replaces `stdio-bridge` and `stdio-entry`.

Today a stdio-only client (ACP agents) spawns `stdio-entry.ts` in Bun (`injection.ts:216`–`:220`),
which forwards JSON-RPC lines to the HTTP endpoint through the MCP client. In Rust it is a
subcommand of the `ace` binary that forwards each message's bytes without re-encoding, with the
same 32 MiB queue cap, response limits and close behaviour; `acpStdioInjection` names it when the
switch is on.

- (a): `stdio-bridge.process`, `stdio-results.process`, `acp-listing.process`; the ACP adapter's
  session (a) files that use the bridge.
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
