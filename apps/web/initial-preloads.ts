import { realpathSync } from "node:fs";
import type { Plugin, Rolldown } from "vite";

/**
 * Leave the first paint's own chunks out of every lazy import's preload list (ADR 0056).
 *
 * For each `import()` Vite writes the chunks to preload into the importing chunk
 * (`__vite__mapDeps`). Chunks the entry imports statically have loaded and run before any lazy
 * import can start, so preloading them again does nothing, yet each route definition on the
 * first paint repeats their names. The finer the shared chunks, the longer those lists grow:
 * they are bytes on the critical path that buy nothing.
 *
 * `plugin` records the entry's static closure once the bundle is final; `resolveDependencies`
 * (Vite's `build.modulePreload` hook, which runs after it) drops those chunks. CSS is untouched:
 * Vite keeps its own list for it.
 */
export function initialPreloads(): {
  plugin: Plugin;
  resolveDependencies: (file: string, deps: string[]) => string[];
} {
  let loaded = new Set<string>();
  return {
    plugin: {
      name: "ace:initial-preloads",
      apply: "build",
      generateBundle(_options, bundle) {
        const closure = new Set<string>();
        const visit = (fileName: string) => {
          const chunk = bundle[fileName];
          if (!chunk || chunk.type !== "chunk" || closure.has(fileName)) return;
          closure.add(fileName);
          for (const imported of chunk.imports) visit(imported);
        };
        for (const output of Object.values(bundle))
          if (output.type === "chunk" && output.isEntry) visit(output.fileName);
        loaded = closure;
      },
    },
    resolveDependencies: (_file, deps) => deps.filter((dep) => !loaded.has(dep)),
  };
}

type ChunkGroup = Exclude<NonNullable<Rolldown.OutputOptions["codeSplitting"]>, boolean>["groups"];

/**
 * Bundle everything the first paint loads, except the entry module itself, into one chunk
 * (ADR 0056).
 *
 * Rolldown splits modules by the set of entries (the page and every lazy import) that reach
 * them. A module the shell imports and a route imports too gets a chunk of its own, though the
 * shell has always loaded it before any route can ask for it. The first paint was 97 files: each
 * gzipped on its own, each repeating its imports and exports, each named in the preload lists.
 * As one chunk the same code is about 40 KB gzip smaller and arrives in one request. Lazy chunks
 * import what they share with the shell from it, which has already run.
 *
 * Rolldown tags the entry's static closure `$initial`. The entry (`src/main.tsx`) and the HTML
 * page that loads it stay out of the group so the build keeps its entry chunk.
 */
export function initialChunk(entry: string): NonNullable<ChunkGroup>[number] {
  if (process.platform === "win32") return windowsInitialChunk(entry);
  return {
    debugName: "initial",
    tags: ["$initial"],
    name: (id) => (id === entry || id.endsWith(".html") ? null : "initial"),
  };
}

/**
 * Windows: one spelling for a module path, so the entry is recognised however the checkout is
 * reached. The path `fileURLToPath` gives (`D:\\a\\src\\main.tsx`) need not be the bundler's
 * module id (`D:/a/src/main.tsx`), and a checkout behind a junction, symlink or `subst` drive, or
 * spelled with a `\\?\\` prefix, names the same file differently again. Missed, the entry joins
 * the shared chunk, and its top-level `await` then holds every lazy chunk the boot imports,
 * which waits on it in turn: the page never gets past "Starting ace…".
 */
export function windowsModuleKey(id: string, realpath: (path: string) => string): string {
  const path = id.replace(/[?#].*$/, "").replace(/^(?:\\\\|\/\/)\?[\\/]/, "");
  let real = path;
  try {
    real = realpath(path);
  } catch {
    // Virtual modules and missing files keep the spelling they have.
  }
  return real
    .replace(/^(?:\\\\|\/\/)\?[\\/]/, "")
    .replaceAll("\\", "/")
    .toLowerCase();
}

/** Windows: the same group, with the entry matched by `windowsModuleKey`. */
export function windowsInitialChunk(
  entry: string,
  realpath: (path: string) => string = realpathSync.native,
): NonNullable<ChunkGroup>[number] {
  const keys = new Map<string, string>();
  const key = (id: string) => {
    let known = keys.get(id);
    if (known === undefined) keys.set(id, (known = windowsModuleKey(id, realpath)));
    return known;
  };
  const target = key(entry);
  return {
    debugName: "initial",
    tags: ["$initial"],
    name: (id) => (key(id) === target || id.endsWith(".html") ? null : "initial"),
  };
}

/**
 * Windows build guard: the page entry must keep a chunk of its own (`windowsInitialChunk`). If
 * it ever lands in a shared chunk the build fails here instead of shipping a page that hangs.
 */
export function windowsEntryGuard(
  entry: string,
  realpath: (path: string) => string = realpathSync.native,
): Plugin {
  const target = windowsModuleKey(entry, realpath);
  return {
    name: "ace:windows-entry-chunk",
    apply: "build",
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk" || output.isEntry) continue;
        if (Object.keys(output.modules).some((id) => windowsModuleKey(id, realpath) === target))
          this.error(
            `The page entry (${entry}) was bundled into the shared chunk ${output.fileName}; its top-level await would hang every lazy chunk loaded during boot.`,
          );
      }
    },
  };
}
