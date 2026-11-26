import { decodeBase64 } from "@ace/client";
import { init } from "@ace/editor";
import { call } from "./host.ts";

/** The VM has no browser fetch for bundle resources. Load the bytes only on first merge. */
export function prepareCheckoutEditor(): Promise<void> {
  return (loading ??= load().catch((error: unknown) => {
    loading = undefined;
    throw error;
  }));
}

let loading: Promise<void> | undefined;

async function load(): Promise<void> {
  const [module, bytes] = await Promise.all([
    import("@ace/editor/pkg/editor_wasm.js"),
    call("editor.wasm"),
  ]);
  await init({ module, wasm: decodeBase64(bytes, bytes.length) });
}
