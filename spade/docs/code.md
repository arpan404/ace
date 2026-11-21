# A package's own code

Date: 2026-11-20. As built for
[ADR 0203](../../docs/adr/0203-spade-packages-ship-sandboxed-webassembly.md), work packages 1
and 2: the interface, the check on the market and the device, and the worker that runs
components. Routing code tools through the gate (`code_<component>_<tool>` in a `code` module of
`spade.v1`) and scenario tests that run code are the next work packages; the call path below is
what they call.

## The interface

`spade/spec/code/package.wit` is `spade:package@1.0.0` (written `spade:%package`: `package` is a
WIT keyword). Values cross as JSON text, and a call that gives no answer gives a `string`
saying why.

| Interface          | Direction | What it is                                                                 |
| ------------------ | --------- | -------------------------------------------------------------------------- |
| `tools`            | import    | `call(name, input) -> result<json, string>`: a `spade.v1` tool, as the bot |
| `http`             | import    | `send(request) -> result<response, string>`: one https request, by Spade   |
| `log`              | import    | `write(level, line)`: kept with the call, at most 64 KiB a call            |
| `kv`               | import    | `get`, `set`, `delete`, `keys`: the package's store on this bot            |
| `toolbox`          | export    | `tools() -> json` (the list of its tools) and `call(name, input)`          |
| `contract-handler` | export    | phase 2                                                                    |
| `check`            | export    | phase 3 (ADR 0204)                                                         |
| `card-data`        | export    | phase 3                                                                    |

Worlds: `bot-tools` (exports `toolbox`; the only one this Spade runs), `bot-contracts`,
`bot-checks`, `bot-cards`. Besides Spade's interfaces a component may import
`wasi:clocks/wall-clock@0.2.x`, `wasi:clocks/monotonic-clock@0.2.x` (with the `wasi:io/poll` it
uses) and `wasi:random/random@0.2.x`. Nothing else: no `wasi:filesystem`, `wasi:sockets`,
`wasi:cli` or `wasi:http`.

## The manifest

`bot.json` v3's `code`, read by `spade_core::package::code` and by `codeProblems` in
`@ace/marketplace` (the conformance suite's `code` part, `spade/spec/conformance/code/`, holds both to the same
sentences; the spec's part is [`spade/spec/code.md`](../spec/code.md)):

```json
"code": [
  {
    "name": "fares",
    "file": "code/fares.wasm",
    "world": "spade:package/bot-tools@1.0.0",
    "imports": ["spade:package/tools", "wasi:clocks/wall-clock@0.2"],
    "why": "Parses fare tables and picks the cheapest.",
    "timeout_s": 30,
    "memory_mb": 128
  }
]
```

At most four components. `name` is 1 to 24 lower-case letters and digits; `file` is
`code/<name>.wasm`; `imports` lists names from the table above (`spade:package/http` needs a
declared `network` effect with hosts); `timeout_s` is 1 to 300 (default 30), `memory_mb` 1 to
512 (default 128). Under `code/` a package may also hold `code/src/` and `code/build.json`;
any other file there is refused.

## The check

`spade_core::package::code::inspect` reads a component's bytes with `wasmparser`: at most
8 MiB, a component (a core module is refused), never precompiled code (a `.cwasm` is a native
object file), valid with exactly the features the worker's engine enables (WebAssembly 2.0
without `externref`, and the component model). Its outermost imports must all be in Spade's
world, and `check` holds them to the manifest's list exactly, both ways. The review row is built
from the binary's list: "Runs its own code: fares. It can call Spade's tools as this bot."

| Where                  | What runs                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| The market's Worker    | `readRecipe`, the header and size of each `code/*.wasm`, and the files scan accepting them |
| The scan's disposition | every version with code is runnable, so held for a maintainer, whoever publishes it        |
| The signer             | `spade --code-check <folder>` (Spade's program) reads every binary; a mismatch is blocked  |
| `spade --bot-test`     | the same check before the scenarios run                                                    |
| The worker             | `inspect` again before it compiles, and its hash against the one Spade named               |

A signer without Spade's program leaves a version with code pending, as with tests.

Every refusal names its rule, `code.*` in `spade_core::rule` (`spade/spec/conformance/rules.json`):
the conformance suite's code cases are matched by rule id in both readers, in `bot.schema.json`
for the rules a schema decides, and at `spade-conform`'s Reader level.

## The worker

`spade-wasm` (crate `spade/crates/spade-wasm`), on Wasmtime 48.0.10 pinned in `spade/Cargo.toml`:
Cranelift, the runtime and the component model, nothing more. One worker per bot with code,
started by `launch::command` inside the bot's sandbox with `Runner::wrap_offline` (no socket,
no connect, no listen), its own folder as its only one, and a bare environment. `spade-wasm` is
its own sandbox launcher. A machine that can't hold it offline doesn't run code.

Spade speaks to it over stdin and stdout: a 4-byte length, then JSON, at most 16 MiB a frame
(`frame`, `protocol`). Spade writes a component's signed bytes into the worker's folder under
their sha256 and sends `load`; the worker checks, compiles and links it. A `call` runs on a
thread of its own, in a store of its own with one instance. `tools`, `http` and `kv` are sent to
Spade as `host` requests and the call waits for the `reply`; the worker decides nothing.

| Bound  | How                                                                                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Time   | Epoch interruption, ticked every 10 ms; the deadline counts only running time (waits on Spade are paused)                                              |
| Work   | Fuel, 10 billion units a call; out of fuel is its own cut                                                                                              |
| Memory | A `ResourceLimiter` holding the call's bound; growing past it traps; the peak is reported                                                              |
| Calls  | At most four at once per bot (`BotCode`'s slots; the worker refuses a fifth)                                                                           |
| Stop   | `BotCode::stop` sends Stop: the next tick ends a running call, a call waiting on Spade ends at once; a call still open a second later kills the worker |
| Pause  | `BotCode::pause` stops and kills the worker                                                                                                            |

A call answers `done` (the component's output or its own failure) with its run time, fuel and
peak memory, or `failed` with one cut: `deadline`, `fuel`, `memory`, `trap`, `stopped`,
`refused` or `lost`. A worker that dies with calls open reports each as `stopped` when Stop was
asked, else `lost`: never done. The next call starts a fresh worker and loads every component
again.

## Not built yet

- The `code` module and its tools, the gate's effect for a code tool, taint, and the Running
  page's accounting (work package 3); scenario tests running code (work package 4).
- Installing a package's components from the signed envelope into the bot's worker folder.
  `BotCode::add` takes the bytes; the server doesn't call it yet.
- A compile cache keyed by sha256 and Wasmtime's version: each worker compiles at load.
  Wasmtime's `deserialize` is `unsafe`, which Spade's crates forbid.
- An update that adds a component or an import saying "Asks for more" and starting it off: the
  link doesn't keep code switches yet.
- The review row on the desktop and iPhone install pages: the daemon's review carries `code`
  rows; the pages don't draw them yet.
- Windows: the worker runs where `wrap_offline` holds it, which on Windows is AppContainer with
  no network; not run there yet.
