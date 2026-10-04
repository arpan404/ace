import type { Plugin } from "vite";

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
