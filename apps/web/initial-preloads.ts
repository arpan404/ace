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
  return {
    debugName: "initial",
    tags: ["$initial"],
    name: (id) => (id === entry || id.endsWith(".html") ? null : "initial"),
  };
}
