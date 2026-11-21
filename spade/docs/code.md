# A package's own code

Date: 2026-11-20. As built for
[ADR 0203](../../docs/adr/0203-spade-packages-ship-sandboxed-webassembly.md), work packages 1
to 4: the interface, the check on the market and the device, the worker that runs components,
install and the gate (`code_<component>_<tool>` in `spade.v1`'s `code` module), and scenario
tests that run code.

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

## Install

The daemon sends each component beside the manifest with an install, an update or a rollback
(`code`: path to base64, as it sends panel pages). Spade (`code::accept`) holds each to its
entry with `check`, and a market version's to exactly the bytes its signed manifest lists (size
and sha256); anything else refuses the step. Accepted bytes are kept once by sha256 in Spade's
own folder (`<data>/code/blobs`, which no run sees), and the step pins each component to its
sha256 (`Link::code`, kept with a pending or held step too). A local package's identity counts
its code, so a version whose code alone changed is another version.

Each bot with code gets its own worker, started at its first call, whose only folder
(`<data>/code/bots/<bot>`) holds copies of exactly its switched-on pinned bytes: a component that
is off is never copied, loaded, listed or run, and its switch is read again right before its tools
are listed. Turning a component's switch on or off ends the bot's worker. A step that commits, Pause
and removing the bot end the worker and its folder; the next call starts from the link's pins.
As Spade opens, kept bytes no link, pending step or held step names go, with folders of bots
that are gone. After an install, a step and Spade's start each component is asked for its tools
(`toolbox.tools`), so the next turn is offered them.

Each component has a switch beside the effects', `code:<name>`. An install turns on each
component the review listed unless the person turned it off there. An update or rollback keeps a
component's switch when it imports nothing more; one that is new, or imports something more,
asks for more (`plan.asks_more`) and starts off. The bot's Security page switches it like an
effect.

## Code tools and the gate

Each switched-on component's tools are offered to its bot, deferred, as
`code_<component>_<tool>` (`code::tools`, a tool source per conversation), in `spade.v1`'s `code`
module; a package that narrows `uses` names `code` to have them. A code tool's effect is its
component's imports' (`network` with `http`, else `write_local` with `kv`, else `read`), and the
model's call is gated as any tool's, its package's ceiling first.

Then it runs (`engine::code`), and Spade decides each request it makes:

| Request | What Spade does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools` | Only from a component whose pinned entry imports `spade:package/tools`, whatever the worker sends; a name over 64 characters is refused, and the call's log of what it called is bounded (64 lines, 4 KiB). Only Spade's own `spade.v1` tools, not those the turn answers itself, a bot's own task or face, `bot_create`, `club_add`, `shell` or `service_start` (`code::run::call_refusal`). Routed by `code::run::route`: the gate's own route, ceiling first, in every mode; nothing the person answered before carries to code, and what a reviewer would read goes to the person |
| `http`  | Only https, only to a host the package declares under `network` with its switch on. Each request is decided afresh before its egress ticket (`code::run::http_route`): the organization's policy and the package's ceiling as they are now, in every mode; once anything untrusted is in view (an earlier answer included) the request goes to the person, and on a shared bot to its approvers. Sent by Spade through the bot's egress proxy on a ticket of its own, so the bot's network settings and egress log hold it                                                            |
| `kv`    | Not in this build: answered with why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

What code puts to the person is asked in the bot's conversation as an ordinary approval, named
`<call id>-code-ask-<n>`, with "fares's own code asks for this." The call waits for the answer
(waiting doesn't count against its deadline); Stop ends the wait. A request left open by a
restart is closed when its call is found cut off. A send from code is the person's every time.

The answer is untrusted when the call's input was (untrusted content in view), when it made any
`http` request, or when a tool it called answered untrusted content. A call that gave no answer
reads as one line, "fares stopped: it ran longer than 30 s."; one cut off after it called a tool
reads as maybe run.

Each call stores `code_ran` (component, run time, fuel, peak memory, why it gave no answer, hosts
reached, tools called with how each ended). Stop on the bot drops the call: the worker is told
at once, and its `code_ran` reads `stopped`. The Running page sums a bot's code calls beside
spend, and marks a component whose last three calls each trapped or ran past a bound, with the
reason; nothing turns it off on its own.

The worker is Spade's own binary started with `--code-worker` (the same worker as `spade-wasm`,
linked in, so a release ships one binary). It compiles nothing unless it runs inside Spade's
offline sandbox: a connection to this machine must be refused by the sandbox, not by the port,
so a worker started by hand loads no component. The memory bound holds all of a call's linear
memories together. A call's answer or request too large for the 16 MiB pipe reads as a failure,
never a hang, and a pipe that breaks ends the worker (its open calls read stopped or lost).

## Scenarios

`spade --bot-test` installs a package's components with it and runs them on a worker in the
sandbox, offline. A component's `http` requests are answered by the scenario's `tools` fakes
named `http:<host>` (each host's answers in turn, the last again); its `tools` calls reach the
same tools as the model's. `expect.results` checks fields of a tool's last answer, read as a JSON
object, so a scenario fails when the code's answer is wrong:

```json
"tools": { "http:api.example-fares.com": "{\"fare\":120}" },
"expect": { "results": { "code_fares_cheapest": { "fare": 120 } } }
```

## Not built yet

- `kv` (the package's store on this bot), contract handlers, checks and card shapers (phases 2
  and 3).
- A compile cache keyed by sha256 and Wasmtime's version: each worker compiles at load.
  Wasmtime's `deserialize` is `unsafe`, which Spade's crates forbid.
- Moving a bot with code to another machine (ADR 0187): its components aren't carried yet.
- The review rows on the desktop and iPhone install pages: the daemon's review carries `code`
  rows; the pages don't draw them yet.
- Windows: the worker runs where `wrap_offline` holds it, which on Windows is AppContainer with
  no network; not run there yet.
