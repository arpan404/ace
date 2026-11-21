<!-- spec:begin header -->
# Spade Agent Format 1.0: Code

<!-- SPDX-License-Identifier: CC-BY-4.0 -->
<!-- Text between spec:begin and spec:end marks is written from Spade's data (ADR 0201 §4). Don't edit it by hand: change the data and run `SPADE_WRITE_SPEC=1 cargo test -p spade-core spec_doc`. -->

Part `code`, version 1.0, of the [Spade Agent Format](README.md) 1.0. WebAssembly components a package ships: Spade's world `spade:package@1.0.0`, what a component may import, its manifest entry, the checks its binary passes and the bounds of a call.

This text is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); the schemas and the conformance suite under Apache-2.0 ([LICENSE.md](LICENSE.md)). The key words MUST, MUST NOT, SHOULD and MAY are to be read as RFC 2119 and RFC 8174 define them, when in capitals.
<!-- spec:end header -->

A package may ship its own code as WebAssembly components ([ADR 0203](../../docs/adr/0203-spade-packages-ship-sandboxed-webassembly.md)).
A component declares every function it imports; with no import for a file system, a socket or
a clock, it has none. A runtime runs a component only through the interfaces of Spade's world,
so every effect the code has is a call the runtime decides on.

## Spade's world

[`code/package.wit`](code/package.wit) is the WIT package `spade:package@1.0.0`. Its worlds:

| World           | Exports            | Status                      |
| --------------- | ------------------ | --------------------------- |
| `bot-tools`     | `toolbox`          | runs in this version        |
| `bot-contracts` | `contract-handler` | defined; a later version runs it |
| `bot-checks`    | `check`            | defined; a later version runs it |
| `bot-cards`     | `card-data`        | defined; a later version runs it |

`toolbox` has `tools() -> json`, the list of its tools as JSON (each with `name`, `summary`,
`input_schema` and `output_schema`), and `call(name, input) -> result<json, string>`. Each tool
becomes one of the bot's tools. Values cross as JSON text, and a call that gives no answer
gives a `string` saying why.

A component MAY import only these, and only those its manifest entry lists. A runtime MUST
refuse a component that imports anything else (`wasi:filesystem`, `wasi:sockets`, `wasi:cli`,
`wasi:http`, threads and every other interface). `wasi:io/poll@0.2` MAY appear beside the
monotonic clock, whose interface uses it, and `spade:package/types` beside any of Spade's
interfaces.

<!-- spec:begin imports -->
| Import | Effect the gate reads |
| --- | --- |
| `spade:package/tools` | the called tool's, at each call |
| `spade:package/http` | `network` |
| `spade:package/log` | none |
| `spade:package/kv` | `write_local` |
| `wasi:clocks/wall-clock@0.2` | none |
| `wasi:clocks/monotonic-clock@0.2` | none |
| `wasi:random/random@0.2` | none |
<!-- spec:end imports -->

The clocks and `random` are WASI 0.2 (any `0.2.x`); Spade's interfaces are any `1.0.x`. A code
tool's effect is the strongest among its imports: `network` with `http`, else `write_local` with
`kv`, else `read`; a `tools` call carries the called tool's effect and is gated as that tool.

## The manifest

`bot.json`'s `code` names each component:

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

- `name` is 1 to 24 lower-case letters and digits, starting with a letter, and unique.
- `file` MUST be `code/<name>.wasm`. Under `code/` a package MAY also hold `code/src/` and
  `code/build.json`; any other file there is refused.
- `world` MUST be a world of Spade's; one the runtime doesn't run yet is refused with "Needs a
  newer Spade".
- `imports` lists the imports above by name. `spade:package/http` needs a declared `network`
  effect that names hosts.
- `why` says in a sentence what the code does. `timeout_s` and `memory_mb` raise the bounds
  below.

## The component

A reader that parses WebAssembly MUST refuse a file that is larger than the bound, a core module
rather than a component, precompiled native code (Wasmtime's `.cwasm` or any other), or a
component that doesn't validate with WebAssembly 2.0 and the component model (no type that needs
a garbage collector, no threads, memory64, exceptions or async). It MUST read the component's
outermost imports from the binary and refuse the package when they differ from the manifest's
`imports` in either direction. A review shows the binary's list.

A runtime compiles only bytes whose hash the signed version manifest covers
([distribution](distribution.md)), and never takes compiled code from a package or another
machine.

## A call

A code call is a tool call, and has a tool call's kind of bound, never one on the task:

<!-- spec:begin bounds -->
| Bound | Value |
| --- | --- |
| Components in a package | 4 |
| A component's size | 8 MiB |
| A call's running time | 30 s by default, up to 300 s with `timeout_s`; waits on the runtime don't count |
| A call's fuel | 10,000,000,000 units |
| An instance's linear memory | 128 MiB by default, up to 512 MiB with `memory_mb` |
| Tables per instance | 16 |
<!-- spec:end bounds -->

A runtime MUST run a component outside its own process, with no network, files or authority
of its own: `tools`, `http` and `kv` are requests the runtime carries out after its gate. Stop
on the bot MUST end its open code calls; a call cut off by Stop, its bounds, a trap or a worker
that died MUST be reported as stopped or failed, never as done.

## Rules

A reader names each refusal by its rule, so a case matches a refusal by id, never by its words.

<!-- spec:begin rules -->
From [`conformance/rules.json`](conformance/rules.json).

| Rule | A reader MUST refuse | The JSON Schema decides it |
| --- | --- | --- |
| `code.list` | `code` isn't a list of at most 4 components. | yes |
| `code.field` | A component's entry isn't an object. | yes |
| `code.name` | A component's name isn't 1 to 24 lower-case letters and digits, starting with a letter. | yes |
| `code.name-unique` | Two components have one name. | no |
| `code.file` | A component's file isn't `code/<name>.wasm`: never precompiled code, never outside `code/`. | no |
| `code.world` | A component's world isn't one of Spade's. | yes |
| `code.world-later` | A component is built for a world of Spade's that the runtime doesn't run yet. | no |
| `code.imports` | A component's `imports` isn't a list of interface names. | yes |
| `code.import` | A component imports something outside Spade's world: a file system, sockets, the command line, incoming HTTP, threads or any other interface. | yes |
| `code.import-twice` | A component lists an import twice. | yes |
| `code.http-network` | A component imports `spade:package/http` and the package declares no `network` effect naming hosts. | no |
| `code.why` | A component doesn't say what its code does, in 1 to 500 characters. | yes |
| `code.bound` | A component's `timeout_s` isn't 1 to 300, or its `memory_mb` 1 to 512. | yes |
| `code.file-missing` | A component the manifest names isn't in the package. | no |
| `code.stray` | A file under `code/` isn't a named component, `code/src/` or `code/build.json`. | no |
| `code.binary` | A component's bytes aren't a component of Spade's world: over 8 MiB, a core module, precompiled code, invalid with the features a runtime enables, importing outside the world, or exporting what the world doesn't. | no |
| `code.binary-imports` | A component's binary imports differ from its entry's `imports`, either way. | no |
<!-- spec:end rules -->

## Cases

<!-- spec:begin cases -->
From [`conformance/code/manifests.json`](conformance/code/manifests.json).

| Case | What it is | A reader MUST |
| --- | --- | --- |
| `code/a-component-that-calls-spades-tools-and-reads-the-clock` | a component that calls Spade's tools and reads the clock | accept |
| `code/a-component-with-http-which-the-packages-network-hosts-allow` | a component with http, which the package's network hosts allow | accept |
| `code/a-component-that-imports-wasi-filesystem` | a component that imports wasi:filesystem | refuse by `code.import` |
| `code/a-component-that-imports-wasi-sockets` | a component that imports wasi:sockets | refuse by `code.import` |
| `code/a-component-that-imports-anything-else` | a component that imports anything else | refuse by `code.import` |
| `code/a-component-with-http-and-no-network-hosts` | a component with http and no network hosts | refuse by `code.http-network` |
| `code/precompiled-code` | precompiled code | refuse by `code.file` |
| `code/a-file-outside-code` | a file outside code/ | refuse by `code.file` |
| `code/a-world-this-spade-doesnt-run-yet` | a world this Spade doesn't run yet | refuse by `code.world-later` |
| `code/a-world-that-isnt-spades` | a world that isn't Spade's | refuse by `code.world` |
| `code/five-components` | five components | refuse by `code.list` |
| `code/two-components-of-one-name` | two components of one name | refuse by `code.name-unique` |
| `code/a-component-name-that-isnt-a-word` | a component name that isn't a word | refuse by `code.name` |
| `code/an-import-listed-twice` | an import listed twice | refuse by `code.import-twice` |
| `code/a-component-without-imports-listed` | a component without imports listed | refuse by `code.imports` |
| `code/a-component-without-a-why` | a component without a why | refuse by `code.why` |
| `code/a-deadline-past-five-minutes` | a deadline past five minutes | refuse by `code.bound` |
| `code/more-memory-than-512-mib` | more memory than 512 MiB | refuse by `code.bound` |
| `code/code-that-isnt-a-list` | code that isn't a list | refuse by `code.list` |
<!-- spec:end cases -->
