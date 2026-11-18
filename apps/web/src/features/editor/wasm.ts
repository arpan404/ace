import { init } from "@ace/editor";

/*
 * Loads the editor's Wasm once per page. A browser build fetches the module the package ships
 * beside itself; jsdom (the web app's tests) cannot import that URL, so tests hand the loader
 * the built files from disk instead, exactly as `packages/editor`'s own tests do.
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
  await init();
}
