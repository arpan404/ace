import { setFlagsFromString } from "node:v8";

/**
 * Keeps V8's WebAssembly-to-JavaScript call wrappers on their generic version for this whole
 * process, so they are never tiered up.
 *
 * Node 24's V8 (13.6) can abort the process when it frees a tiered-up wrapper whose code page
 * a worker isolate already released (`Check failed: jit_page.has_value()` in
 * `ThreadIsolation::UnregisterWasmAllocation`, nodejs/node#66366; fixed in V8 upstream, not yet
 * in Node 24). The daemon runs worker threads, and Node itself runs WebAssembly in them (its
 * HTTP parser, its CommonJS lexer, TypeScript stripping in development), so a worker ending
 * could take the daemon down. The generic wrapper is slightly slower per call and is what V8
 * uses before tier-up anyway. Workers read the flag when they start; call this before any.
 */
export function keepWasmWrappersGeneric(): void {
  setFlagsFromString(`--wasm-wrapper-tiering-budget=${2 ** 31 - 1}`);
}
