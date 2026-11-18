import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { init } from "./loader.ts";

const wasmFile = new URL("../pkg/editor_wasm_bg.wasm", import.meta.url);

/**
 * Loads the built Wasm from disk, which works the same on Node and Bun: neither can fetch a
 * `file:` URL, so the bytes go to `WebAssembly.instantiate` directly.
 */
export async function initForTests(): Promise<void> {
  await init({ wasm: readFileSync(fileURLToPath(wasmFile)) });
}
