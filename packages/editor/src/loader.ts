import type { WasmGlue } from "./wasm-types.ts";

/** What `init` may be given beyond the defaults. */
export interface InitOptions {
  /** An already-imported glue module, for a bundler that emits it as a static import. */
  module?: WasmGlue;
  /** The generated glue module. Defaults to the built `pkg/` beside this package. */
  moduleUrl?: string | URL;
  /**
   * Handed to the generated loader: wasm bytes, a compiled module, or a URL. Left out, the
   * loader fetches the `.wasm` beside the glue, which is what a browser build wants.
   */
  wasm?: unknown;
}

const defaultModuleUrl = new URL("../pkg/editor_wasm.js", import.meta.url);

let glue: WasmGlue | undefined;
let loading: Promise<WasmGlue> | undefined;

/**
 * Loads and instantiates the editor's Wasm. Call it once before constructing a document; calls
 * after the first share the same module. A failed load is not cached, so a retry can succeed.
 */
export async function init(options: InitOptions = {}): Promise<void> {
  await load(options);
}

/** The loaded module. Throws a plain error when [`init`] has not finished. */
export function wasm(): WasmGlue {
  if (!glue) {
    throw new Error("editor Wasm is not initialised: await init() before using the editor");
  }
  return glue;
}

function load(options: InitOptions): Promise<WasmGlue> {
  if (glue) {
    return Promise.resolve(glue);
  }
  const pending = (loading ??= instantiate(options));
  pending.catch(() => {
    loading = undefined;
  });
  return pending;
}

async function instantiate(options: InitOptions): Promise<WasmGlue> {
  const module = options.module ?? (await importGlue(options.moduleUrl));
  // The generated loader reads the modern single-object form; a bare value logs a deprecation.
  const input = options.wasm === undefined ? undefined : { module_or_path: options.wasm };
  await module.default(input);
  glue = module;
  return module;
}

async function importGlue(moduleUrl: string | URL | undefined): Promise<WasmGlue> {
  const target = moduleUrl ?? defaultModuleUrl;
  const url = typeof target === "string" ? target : target.href;
  return (await import(/* @vite-ignore */ url)) as WasmGlue;
}
