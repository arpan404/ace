import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Where the installed `@markit/web` package keeps its files, for build scripts and tests that copy
 * or read them (the worker, the Wasm, the licence notices). ace installs markit prebuilt from its
 * GitHub release (the tarball in this package's dependencies), so nothing here builds Rust.
 */
export function markitPackageDirectory(): string {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve("@markit/web/package.json"));
}

/** markit's Wasm module, as installed. */
export function markitWasmFile(): string {
  return join(markitPackageDirectory(), "pkg", "markit_wasm_bg.wasm");
}
