import { init } from "@ace/editor";
import * as glue from "@ace/editor/pkg/editor_wasm.js";

/*
 * Loads the editor's Wasm once per page. Vite emits the glue and the `.wasm` beside the app's
 * bundle, so both are static imports; jsdom (the web app's tests) reads the built bytes from
 * disk instead, exactly as `packages/editor`'s own tests do.
 */

let loading: Promise<void> | undefined;

/** Resolves when an {@link import("@ace/editor").EditorDocument} can be constructed. */
export function ensureEditorReady(): Promise<void> {
  if (!loading) {
    loading = start();
    loading.catch(() => {
      loading = undefined;
    });
  }
  return loading;
}

async function start(): Promise<void> {
  if (import.meta.env.MODE === "test") {
    const { initEditorForTests } = await import("./test-support.ts");
    await initEditorForTests();
    return;
  }
  // The glue's own `new URL('editor_wasm_bg.wasm', import.meta.url)` is what Vite rewrites
  // and emits beside the bundle, so the loader fetches it without a second URL import.
  await init({ module: glue });
}
