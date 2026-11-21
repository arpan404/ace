# 0203: Spade packages may ship sandboxed WebAssembly

Status: accepted. Date: 2026-11-20. Decided by: the founder (2026-11-20), taking every
recommendation below. Amends [ADR 0200](0200-spade-is-an-agent-operating-system.md) §11 ("a
package running code in Spade's or ace's process") and phase 4's "packages that run their own
long-lived code", and [ADR 0174](0174-market-publishers-discovery-and-scanning.md) §8's `files`
check ("WASM outside a plugin"). Builds on [ADR 0167](0167-spade-security-boundaries.md) (the
sandbox and the egress proxy), [ADR 0171](0171-spade-decides-on-effects.md) (effects),
[ADR 0158](0158-spade-no-fixed-step-or-time-limits.md) and
[ADR 0166](0166-spade-has-no-spending-limits.md) (no task limits or caps).

## Context

A package's logic today is its task, read by a model, plus skill scripts run with `shell` in the
bot's sandbox. That caps what packages can do:

- Exact work (parse a fare table, score a diff, check a schema, compute a date) costs a model call
  and is sometimes wrong.
- A skill script needs an interpreter on the machine, so a package can't count on it.
- A contract always needs a model turn to answer, even when the answer is a lookup.
- Scripts are opaque to the gate. `shell` is `write_local`, and what a script reaches is read by
  the shell classifier, one command at a time.

WebAssembly components fit the gap. A component declares every function it imports. With no
import for a file system, a socket or a clock, it has none: there is no ambient authority. The
[component model](https://component-model.bytecodealliance.org/) defines components and their
interfaces in WIT. WASI 0.2 is stable, and WASI 0.3, which adds native `async`, `stream<T>` and
`future<T>` to the component model, was ratified on 2026-06-11
([announcement](https://bytecodealliance.org/articles/WASI-0.3),
[release](https://github.com/WebAssembly/WASI/releases/tag/v0.3.0)). The reference runtime,
Wasmtime, is a Rust library, so Spade can host it. It meters work with fuel
(`Config::consume_fuel`, deterministic) or epochs (`Config::epoch_interruption`, cheap, wall
clock), and bounds memory per store with `StoreLimits` and the `ResourceLimiter` trait
([interrupting execution](https://docs.wasmtime.dev/examples-interrupting-wasm.html),
[`Config`](https://docs.wasmtime.dev/api/wasmtime/struct.Config.html),
[`ResourceLimiter`](https://docs.wasmtime.dev/api/wasmtime/trait.ResourceLimiter.html)).

## Options considered

- **Keep packages code-free.** Safest. Leaves the cap the reviews called out. Rejected.
- **Let packages ship scripts for the OS sandbox.** Needs interpreters, and the gate sees only
  commands. Rejected for new logic; skill scripts stay as they are.
- **Run components in Spade's own process.** Fast, but a Wasmtime bug would be a hole in Spade
  itself, and ADR 0200 keeps package code out of Spade's process. Rejected.
- **Run components in a separate worker process under the bot's OS sandbox, with only declared
  imports.** Two layers: the component model's, and the sandbox's. Chosen.

## Decision

### 1. What a package may ship

- Components under `code/<name>.wasm`, at most 8 MiB each and four per package, inside ADR 0103's
  package limits. Only WebAssembly components built for Spade's world (section 2). Core modules,
  precompiled native artefacts (Wasmtime's `.cwasm` or any other) and components for another
  world are refused.
- A package names each component in `bot.json`:

```json
"code": [
  {
    "name": "fares",
    "file": "code/fares.wasm",
    "world": "spade:package/tools@1.0.0",
    "imports": ["spade:package/http", "spade:package/tools", "wasi:clocks/wall-clock@0.2"],
    "why": "Parses fare tables and picks the cheapest."
  }
]
```

- `imports` must equal what the component's binary imports, read from the binary. A difference
  is refused at check. The review shows the binary's list, never the manifest's.
- Source is not required in v1. A package that ships `code/src/` and a `code/build.json` (the
  toolchain image by digest and the build command) can earn "Built from its source" (phase 3).

### 2. Spade's world

A versioned WIT package, `spade:package@1.0.0`, published with the spec (ADR 0201) as part
`code`. A component may export:

| Export                                             | What Spade does with it                                                                                        |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `tools`: functions with a JSON-schema'd input and output | Each becomes a tool of the bot, `code_<name>_<function>`, in a new `code` module of `spade.v1`               |
| `contract-handler`: one function per contract       | The contract is answered by code with no model turn, when `bot.json`'s contract says `"handler": "code/fares#cheapest-fare"` |
| `check`: functions that take a result and answer pass or fail with reasons | Verification steps (ADR 0204)                                                      |
| `card-data`: functions that shape a card's data     | Called by `card_show` when the card says `"shape": "code/fares#fare-card"`                                     |

It may import only these, and only those its manifest lists:

| Import                                   | What it reaches                                                                                                                                         | Effect read by the gate                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `spade:package/tools`                    | Calls a `spade.v1` tool as the bot: `call(name, json) -> result<json, error>`. Every call goes through the gate, the ceiling first                     | The called tool's                                          |
| `spade:package/http`                     | One outgoing https request, sent through the bot's egress proxy, to hosts the package declares under `network` and the person left on. No sockets, no other schemes | `network`                                     |
| `spade:package/log`                      | Lines for the developer, kept with the call, at most 64 KiB a call                                                                                      | none                                                       |
| `spade:package/kv`                       | A small store owned by the package on this bot: get, set, delete, list, at most 16 MiB in all, moved with the bot (0187)                               | `write_local`                                              |
| `wasi:clocks/wall-clock`, `monotonic-clock` | Time                                                                                                                                                 | none                                                       |
| `wasi:random/random`                     | Random bytes                                                                                                                                            | none                                                       |

No `wasi:filesystem`, `wasi:sockets`, `wasi:cli` environment or arguments, `wasi:http` incoming
handler, or threads. A component that imports anything else is refused at check.

- **v1 targets WASI 0.2** imports (`@0.2.x`), which every current toolchain builds. Spade's world
  is written so the same exports can be built against WASI 0.3's async when Spade's pinned
  Wasmtime enables it by default; that is a minor version of `spade:package`, `1.1.0`, accepting
  both.
- A code tool's effect is the strongest effect among its imports, read from the binary:
  `network` with `http`, the called tool's at run time with `tools`, else `write_local` with
  `kv`, else `read`. The ceiling holds it exactly as for any call.

### 3. Where it runs

- In **`spade-wasm`**, a new binary in `spade/crates/spade-wasm`, started per bot that has code,
  inside that bot's OS sandbox (ADR 0167) with no network of its own and no folder but its compile
  cache. It talks to Spade over a pipe with framed, length-bounded messages. It never sees a
  credential or the bot's workspace.
- `http` requests and `tools` calls are made by Spade on the component's behalf, after the gate,
  so the worker holds no authority of its own. If the worker were taken over, it could ask
  Spade, and Spade would decide.
- Wasmtime, pinned in `spade/Cargo.toml`, with the component model on and every proposal Spade
  doesn't use off.
- **Compiled at install**, by Spade, from the signed bytes, into a cache keyed by the
  component's sha256 and Wasmtime's version. A cache entry is never taken from a package or
  another machine.

### 4. Bounds and Stop

ADR 0158 and ADR 0166 forbid limits on a bot's work and spending. A code call is a tool call, and
tool calls already have per-call bounds (a connector call's 60 seconds, ace's 11 minutes). Code
gets the same kind, never one on the task:

- **Time.** Epoch interruption with a deadline of 30 seconds of wall clock per call by default,
  up to 5 minutes when the code entry says `"timeout_s"`. Time spent waiting on Spade for a
  `tools` or `http` call doesn't count: the deadline is re-armed when the host call returns.
- **Work.** Fuel, as a guard against a tight loop that never yields: 10 billion units per call.
  Running out is the same error as the deadline.
- **Memory.** `StoreLimits`: 128 MiB of linear memory per instance by default, up to 512 MiB
  with `"memory_mb"`; at most 16 tables and one instance per call.
- **Concurrency.** At most four code calls at once per bot.
- **Stop.** Stop on the bot ends its open code calls at once: Spade raises the epoch of every
  store of that bot, and kills the worker if it doesn't answer in one second. Pause stops the
  worker. A call cut off reports as stopped, never as done.
- A call that traps, runs out or is stopped answers the bot with one line: "fares stopped: it ran
  longer than 30 s." Nothing retries code on its own. Three traps in a row from the same function
  mark that tool failed in the Running page, with the reason; nothing disables it by itself.
- **Accounting.** Each call's time, fuel and peak memory are stored on its step and summed in the
  Running page (ADR 0200 §6.3) beside spend. Code costs no money.

### 5. Trust: taint, scanning, signing

- **Taint.** A code call's output is untrusted when it made any `http` request or any `tools` call
  whose result was untrusted, or when its input was untrusted. Otherwise it carries its input's
  trust. Untrusted output taints the turn, as a helper's does.
- **Scanning.** The scanner's `files` check accepts components under `code/` of a `spade-bot` v3
  package. On the signer and the device it parses each component with the `wasmparser` crate
  (Rust, run by `ace market maintainer sign` and by Spade at `prepare`), lists its imports and
  exports, and blocks anything outside Spade's world. The Worker, which runs TypeScript, checks
  the component header, the size and the manifest's list, and holds the rest for the signer.
  Every version with code is runnable, so it is held for a maintainer (0174 §8's policy layer),
  whoever publishes it, ace included.
- **Signing.** Each component is a file in the signed version manifest with its sha256 (0168 §6).
  Spade compiles only bytes whose hash the proof covers.
- **Review.** The install review gains a row per component: "Runs its own code: fares. It can
  reach api.example-fares.com and call Spade's tools as this bot." An update that adds a
  component or an import says "Asks for more" and starts that component off.

### 6. Tests in packages

Scenario tests (`spade --bot-test`) run code for real, offline: `http` answers come from the
scenario's `tools` fakes under the name `http:<host>`, and `tools` calls go to the same fakes as
the model's. The signer's run therefore exercises the package's code, not just its wiring.

### 7. Phases

1. **First slice: code tools.** `spade:package@1.0.0` with `tools`, `log`, clocks and random;
   `spade-wasm` in the sandbox on macOS and Linux; bounds and Stop; the `code` module in
   `spade.v1`; the scanner's parse on signer and device; the review row; scenario tests running
   code. No `http`, no `kv`.
2. **Reach.** `http` through the egress proxy and `kv`; taint from `http`; contract handlers.
3. **Checks and source.** `check` and `card-data` exports (with ADR 0204); "Built from its
   source" when the signer's rebuild in the pinned image gives the same bytes.
4. **Windows** once a networked run there is contained (ADR 0167 amendment 2). Until then a bot
   with code on Windows runs code tools without `http`, and the review says so.

## Decided

The founder took each recommendation on 2026-11-20.

1. **Out of process, inside the OS sandbox.** Not in Spade's process.
2. **WASI 0.2 first,** 0.3 accepted as a minor version once the pinned runtime enables it.
3. **Source is optional,** and earns a mark when it rebuilds to the same bytes.
4. **Per-call bounds are tool bounds,** not task limits; ADR 0158 and ADR 0166 stand.
5. **No file system or socket imports.** Files come through `spade:package/tools` as the bot's
   workspace tools, under the gate.

## Consequences

- Packages can do exact, cheap, testable work, and answer contracts without a model.
- The gate sees every effect code has, because code has no effect of its own: it asks Spade.
- Spade ships a Wasmtime build and a second binary. Its size grows.
- Every code package needs a maintainer's read before listing, which is slow. That is on purpose
  until the scanner and the red team (product plan M5) earn trust.
- A new class of bug: a hole in Wasmtime or in Spade's host functions. The OS sandbox is the
  second wall.

## Tests

- Check: a component that imports `wasi:filesystem` or `wasi:sockets` is refused; a core module,
  a `.cwasm` file, or a manifest `imports` list that differs from the binary's is refused; a valid
  component passes and its review row lists the binary's imports.
- The gate: a code tool that imports `http` is refused for a package without `network`; an
  `http` request to a host the person turned off is refused by the proxy; a `tools` call from
  code to `send_message` goes to the person.
- Bounds, on a real `spade-wasm`: an endless loop ends at its deadline and reports it; a call
  that waits 40 s on a slow fake `http` answer isn't cut off at 30 s; growing memory past the
  limit traps; Stop ends a running call within a second and the bot reads stopped, not done.
- Taint: a code call that made an `http` request returns untrusted output, and a note after it
  asks the person.
- A scenario test of a package with code runs the code offline, with `http` from fakes, and fails
  when the code's answer is wrong.
- A process test: kill `spade-wasm` mid-call; the call reports unknown or stopped, and the next
  call starts a fresh worker.
