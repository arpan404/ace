import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { init } from "@ace/editor";

/*
 * Loads the built editor Wasm for jsdom tests, the way `packages/editor`'s own tests do: the
 * bytes go straight to `WebAssembly.instantiate`. jsdom gives `import.meta.url` an http URL, so
 * the glue is passed as a file URL too. `node packages/editor/scripts/build.mjs` builds both.
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
  loading ??= init({
    moduleUrl: pathToFileURL(packageFile("editor_wasm.js")).href,
    wasm: readFileSync(packageFile("editor_wasm_bg.wasm")),
  });
  return loading;
}
