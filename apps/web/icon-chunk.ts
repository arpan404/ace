import type { Rolldown } from "vite";

type ChunkGroup = Exclude<NonNullable<Rolldown.OutputOptions["codeSplitting"]>, boolean>["groups"];
type Group = NonNullable<ChunkGroup>[number];
type ModuleInfo = Pick<Rolldown.ModuleInfo, "code" | "importedIds">;

const phosphorModule = /[\\/]node_modules[\\/]@phosphor-icons[\\/]react[\\/]/;
const phosphorImport = /import\s*\{([^}]*)\}\s*from\s*["']@phosphor-icons\/react["']/g;
/** An icon's own modules: `dist/csr/Gear.es.js` and `dist/defs/Gear.es.js`. */
const iconFile = /[\\/]dist[\\/](?:csr|defs|ssr)[\\/]([^\\/]+)\.es\.js$/;

/** The icon names a module's code imports from Phosphor, without the `Icon` suffix. */
function importedIconNames(code: string): string[] {
  const names: string[] = [];
  for (const match of code.matchAll(phosphorImport))
    for (const specifier of (match[1] ?? "").split(",")) {
      const name = specifier
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+/)[0];
      if (name) names.push(name.replace(/Icon$/, ""));
    }
  return names;
}

/** The icon a Phosphor module draws, if it is one icon's module rather than shared library code. */
function iconOfModule(id: string): string | undefined {
  return id.match(iconFile)?.[1];
}

/**
 * Every icon the app modules statically reachable from `root` import. The walk follows static
 * imports only and stays out of `node_modules`: what loads through `import()` loads later, as
 * its own entry.
 */
function iconsReachedFrom(root: string, info: (id: string) => ModuleInfo | null): Set<string> {
  const icons = new Set<string>();
  const seen = new Set<string>();
  const queue = [root];
  for (const id of queue) {
    if (seen.has(id) || /[\\/]node_modules[\\/]/.test(id)) continue;
    seen.add(id);
    const module = info(id);
    if (!module) continue;
    for (const name of importedIconNames(module.code ?? "")) icons.add(name);
    queue.push(...module.importedIds);
  }
  return icons;
}

/**
 * Phosphor icons that five or more lazy pages share, as two lazy chunks: the ones the thread
 * page draws, and the rest.
 *
 * Left to automatic chunking, each icon shared by several pages became a chunk of its own: over
 * 110 files of 1–3 KB, enough to push the daemon release past the installed updater's
 * 2,048-entry archive budget (`packages/service/src/artifact.ts`; old apps keep that limit, so it
 * can't be raised here). Icons fewer pages share stay with them: gathering every icon made the
 * thread and New thread pages load ~15–37 KB gzip of icons they never draw (bundle budgets in
 * `tools/web-perf`). As one chunk the shared icons were 36 KB gzip, all of it loaded by the
 * thread page, the first screen's heaviest route; the icons it statically imports get a chunk of
 * their own, so it loads only those. Other pages load one chunk or both.
 *
 * The group sits after the initial group at the same priority, so an icon the first paint uses
 * stays in the initial chunk; only the lazy remainder is gathered here.
 *
 * `threadPage` is the module id of the thread route's component (the router plugin's split).
 */
export function lazyIconChunk(threadPage: string): Group {
  let threadIcons: Set<string> | undefined;
  return {
    debugName: "icons",
    includeDependenciesRecursively: false,
    minShareCount: 5,
    test: phosphorModule,
    name: (id, ctx) => {
      threadIcons ??= iconsReachedFrom(threadPage, (module) => ctx.getModuleInfo(module));
      const icon = iconOfModule(id);
      return icon !== undefined && threadIcons.has(icon) ? "icons-thread" : "icons";
    },
  };
}
