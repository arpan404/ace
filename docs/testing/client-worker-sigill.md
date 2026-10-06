# Machine worker SIGILL

Reproduced on 2026-10-06, macOS arm64, Homebrew Node 26.8.1 and Vitest 5.0.3.
No provider CLIs, native application addons, or owner data were used.

The two reported files passed twenty times each, one file per invocation. A real
machine-pool churn test with sixteen fake machines and sixteen replacements per
machine reproduced `Worker exited unexpectedly with signal SIGILL`. The first
run failed in 3.37 seconds. Two of five subsequent runs failed in 7.86 and 2.33
seconds; the other three passed. Failures occur during worker startup or lazy
service loading, before the test can report an assertion failure.

The macOS crash reports from these owned runs show `EXC_BAD_INSTRUCTION/SIGILL`
on a Node worker thread. Generated WebAssembly frames lead into
`Builtins_JSToWasmWrapperAsm`, `Builtins_JSToWasmWrapper`, and the worker message
loop. The loaded-image inventory contains Node/system libraries and no koffi,
pty, descriptor, or other application addon. There are no application abort
calls or changed V8 heap flags in the fixture. Node's native TypeScript loader is
the WASM consumer in this graph. The stack points to that loader, rather than a
JavaScript stack overflow or an addon fault; this is an inference, not a claim
that an upstream issue has been confirmed. Small standalone type-stripping
probes did not reproduce it.

The process setup now builds the complete machine worker fixture once into the
isolated test directory. Real Node workers execute that JavaScript, including
the lazy services, instead of invoking Node's WASM TypeScript loader in every
worker isolate. This also matches the production Vite worker's JavaScript
execution path. Vitest continues using the process pool; no retries, skipped
files, concurrency reductions, or V8 flags are added. Temporary builds are
removed by the existing project teardown.

Five consecutive compiled-fixture churn runs passed, plus the original pending-send
file. The full suite was not run.

The regression drives sixteen independent machines through concurrent creation,
termination and replacement. Each replacement must connect and accept commands
through its real worker channel. It tests behavior rather than bundle structure.

Reproduction and verification:

```sh
bunx vitest run --project process packages/client-worker/src/worker-churn.process.test.ts
bunx vitest run --project process packages/client-worker/src/machine-pending.process.test.ts
bunx vitest run --project process packages/client-worker/src/machines-review.process.test.ts
```

The upstream loader and worker contracts are documented in
[Node TypeScript support](https://nodejs.org/api/typescript.html) and
[worker threads](https://nodejs.org/api/worker_threads.html).
