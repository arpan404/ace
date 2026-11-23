// SPDX-License-Identifier: Apache-2.0
/**
 * Which reducer serves `@ace/core`: today's TypeScript, the napi addon, or wasm (E4).
 *
 * Node decides once, from `ACE_CORE`, when this module is first loaded. A browser has no
 * environment to read: it starts on the TypeScript reducer and switches to wasm only through
 * {@link useCoreBackend}, which {@link startFakeCore} calls before the fake daemon seeds a
 * world. Nothing here touches `node:fs`, so importing `@ace/core` in a browser is safe, and
 * the choice is never a compile-time constant a bundler could fold away.
 */

/** The reducers `@ace/core` can route to. */
export type CoreBackend = "typescript" | "native" | "wasm";

/** The environment a Node process declared, if this is one. */
function declared(): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  return env?.ACE_CORE;
}

const asked = declared();
if (asked !== undefined && asked !== "native" && asked !== "wasm")
  throw new Error("ACE_CORE takes native or wasm");

let backend: CoreBackend = asked === "native" || asked === "wasm" ? asked : "typescript";

/** The backend every `@ace/core` export uses right now. */
export function coreBackend(): CoreBackend {
  return backend;
}

/** Choose the backend explicitly; only a browser's fake daemon needs this. */
export function useCoreBackend(next: CoreBackend): void {
  backend = next;
}

/** Whether the reducer lives behind the native handle (the addon or wasm). */
export function nativeCore(): boolean {
  return backend !== "typescript";
}
