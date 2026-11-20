import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { init } from "@ace/editor";
import * as glue from "@ace/editor/pkg/editor_wasm.js";
import { markitGrammarWasmFile, markitWasmFile } from "@ace/markit-web/assets";

/*
 * Loads the built editor Wasm for jsdom tests, the way `packages/editor`'s own tests do: the
 * bytes go straight to `WebAssembly.instantiate`, through the same static glue the app bundles.
 * `node packages/editor/scripts/build.mjs` builds both (the root postinstall runs it too).
 */

let loading: Promise<void> | undefined;

function packageFile(name: string): string {
  let directory = process.cwd();
  for (let up = 0; up < 6; up++) {
    const candidate = resolve(directory, "packages/editor/pkg", name);
    if (existsSync(candidate)) return candidate;
    directory = resolve(directory, "..");
  }
  throw new Error("The editor Wasm is not built: run node packages/editor/scripts/build.mjs");
}

export function initEditorForTests(): Promise<void> {
  loading ??= init({ module: glue, wasm: readFileSync(packageFile("editor_wasm_bg.wasm")) });
  return loading;
}

/** markit's incremental highlighter runs inline in jsdom, with both of its Wasm modules. */
export function lineHighlighterOptionsForTests() {
  return {
    worker: "inline" as const,
    wasm: readFileSync(markitWasmFile()),
    grammarWasm: readFileSync(markitGrammarWasmFile()),
  };
}
