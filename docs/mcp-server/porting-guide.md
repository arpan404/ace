# Porting MCP server work to Rust

For builders who move a tool family's owner to Rust (ADR 0225, M1), and for every builder whose
switch touches the MCP endpoint. Read
[ADR 0225](../adr/0225-devices-screens-automations-and-the-mcp-server-move-to-rust.md) and
[behaviour.md](behaviour.md) first: the contract there is what you keep, and behaviour.md §5 lists
every test file by class. The engine's [porting guide](../engine/porting-guide.md) sets the rules
for daemon crates; where this guide is silent, follow it.

## What is not ported

`@ace/mcp-server` stays TypeScript: the SDK transport, `startMcpServer`, `ToolRegistry`, the
listings and toolsets, guidance and awareness, the stdio bridge, `PublicToolError` and the
injection helpers. Its transport is 10 to 15% of a call that models make seconds apart, and its
output is Zod- and JavaScript-shaped: descriptors from `z.toJSONSchema`, `invalid_arguments` text
from Zod issues, about 80 fixed public errors. Don't port it, don't add `rmcp` to the daemon's
server side, and don't change a descriptor, an annotation or an error string for a Rust caller.

Two pieces are already owned elsewhere: adapters' sessions redact the bearer from their captures
(`redactMcpCredential`, `injection.ts:212`) and build their provider's injection in ADR 0223 E3;
`rmcp` is the Pi adapter's MCP client there (E3-pi).

The largest measured cost around a call (about 55% of its CPU) is the daemon's store work
recording the call and reading the session's facts for the digest
(`apps/daemon/src/tool-result-mcp.ts:199`, `packages/mcp-server/src/awareness.ts:118`). It is a
TypeScript question for the owner (ADR 0225 question 2), not part of M1.

## Rules for M1

1. **The port moves; the toolkit doesn't.** A family's toolkit takes its owner as a port
   (`agentControlToolkit(port: AgentControlPort)`, `agent-control.ts:27`; `execute(caller,
operation, signal)`, `control-tool.ts:15`). You implement that port over the native handle and
   change nothing in `packages/mcp-server`. Tool names, schemas, titles, risk classes, timeouts,
   annotations and `_meta` stay byte for byte, so `tools/list` is unchanged by construction.
2. **One switch, one line.** `ACE_NATIVE_TOOLS=<family>[,<family>]`, added to
   `packages/provider-kit/src/native-switches.ts`, requiring `ACE_STORE=native` and whatever the
   family's owner needs (`ACE_ENGINE=native` for agent-control). The `if` sits at the top of the
   daemon's port factory (`createAgentControlPort`, `apps/daemon/src/agent-control/tools.ts:174`).
   Set without the addon: refuse; never fall back.
3. **No new tests.** The (a) files below are the proof; you don't edit them. One at a time, after
   `test -f`:

   ```sh
   f=packages/mcp-server/src/lifetime.process.test.ts
   test -f "$f" && ACE_STORE=native ACE_ENGINE=native ACE_NATIVE_TOOLS=agent-control bun --bun x vitest run "$f" --maxWorkers=4
   test -f "$f" && bun --bun x vitest run "$f" --maxWorkers=4
   ```

   Never run the full suite, `bun run test`, `bun run check`, `test:process`, `test:slow` or
   `test:changed`. The daemon's `evals/` tests use a scripted model over the real endpoint and
   spend no quota; never run anything under `tools/recorder` or a `live` test.

4. **What crosses.** The operation as `ToolRegistry.call` parsed it, as `ace-json`; the caller
   (`McpAttribution`) as data; the `AbortSignal` as a cancellation token the Rust task checks at
   each await. Back: the port's result value as `ace-json`, which the toolkit's output schema
   checks as today. A thrown error is mapped to the family's own error class in the shell
   (`AgentControlError`, `agent-control/failure.ts:5`) so `toolFailure` words it.
5. **Words.** `hint` and `publicDetail` are model-facing. If Rust builds them, they must be
   byte-identical, and the family's (a) files prove it; if the family's ADR says otherwise, Rust
   returns the facts and the shell words them with the existing TypeScript.
6. **Same numbers.** The registry's budgets don't move: 64 KiB input unless declared, 256 KiB
   structured results, 1,024 calls and 256 per thread, one deadline from the call's start, at most
   660 s (`maxToolTimeoutMs`); agent-control's `controlToolTimeoutMs` (630 s,
   `control-tool.ts:12`). A port that ignores cancellation keeps its slot until it settles.
7. **Permissions are the provider's.** The native port never asks the person for anything ace
   didn't ask before; annotations decide what the provider gates.
8. **Rust rules**: engine porting guide rules 6 to 9 (no `unsafe`, no `unwrap`, `thiserror`,
   bindings only translate, JSON through `ace-json`, injected clock and ids).

## Files

| Part             | Files (yours)                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| Rust             | the family owner's crate (for agent-control, the crate its ADR names), module `port.rs`             |
| Binding          | `native/daemon/crates/ace-daemon-node/src/tools/<family>.rs`                                        |
| TypeScript shell | `apps/daemon/src/native-tools/<family>.ts` (a port over the handle), the switch line in the factory |

## M1: a tool family's port (first: agent-control)

Proof, switch on and off:

- `packages/mcp-server/src/` (a), all 36 files: they register their own fake tools and must pass
  identically, which proves the registry and transport are untouched.
- `apps/daemon/src/` MCP (a), all 16: `mcp.process`, `mcp-tools.process`,
  `mcp-tools-find.process`, `mcp-guidance.process`, `mcp-awareness.process`, `mcp-roles.process`,
  `mcp-status-groups.process`, `mcp-agent-budget.process`, `mcp-catalogue-budget.process`,
  `mcp-codex-discovery.process`, `mcp-discovery.process`, `mcp-controls.server.process`,
  `mcp-upgrade`, `claude-mcp-privacy.process`, `opencode-mcp.process`, `provider-mcp.process`.
- The family's own (a) files, as its ADR lists them (for agent-control, `apps/daemon/src/agent-control/`
  and the daemon files that build a real `Engine`).
- Cross-mode: the family's restart files through `scripts/native-cross.ts`, both ways.
- Measure: the in-process daemon request measurement of ADR 0225 §Context (`tools/list`,
  `tools/call` p50 and CPU per call, with a `bun --cpu-prof-md` profile), switch off and on, on an
  empty temporary `HOME` and `ACE_HOME`; and `bun packages/mcp-server/bench/dispatch.ts`, which
  must not move.

## When you are done

- Every (a) file above passes alone with the switch on and off; the family's (b) cases pass in
  `cargo test`; `bun run check:daemon-native` passes; the cross-mode list passes both ways.
- Report: the files run and their results, the figures off and on, anything in behaviour.md that
  turned out wrong (with the code that shows it), and the one test you added, if any, with the
  behaviour it covers that nothing did.
- Commit and push as you go with `git push origin HEAD:refs/heads/<your-branch>`; never rebase or
  force-push. Every commit ends with exactly `Co-Authored-By: spade <bot@acehq.dev>`.
