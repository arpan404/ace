import { posix } from "node:path";
import { parseAst, type Rolldown } from "vite";

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

/** Every export of a module is wanted, or only these names. */
type Wanted = "all" | ReadonlySet<string>;

interface Edge {
  source: string;
  wanted: Wanted;
}

/**
 * A module of re-exports only (`export { a } from "./a.ts"`, `export * from`), such as a feature's
 * `index.ts`: importing some of its names reaches only the modules those names come from. Its
 * edges are keyed by the exported name, or `*` for `export * from`.
 */
interface Barrel {
  named: Map<string, Edge>;
  stars: string[];
}

interface AstNode {
  type: string;
  [key: string]: unknown;
}
const isAstNode = (value: unknown): value is AstNode =>
  typeof value === "object" && value !== null && typeof (value as AstNode).type === "string";
const astNodes = (value: unknown): AstNode[] =>
  Array.isArray(value) ? value.filter(isAstNode) : [];
const nameOf = (node: unknown): string | undefined =>
  isAstNode(node)
    ? typeof node["name"] === "string"
      ? node["name"]
      : typeof node["value"] === "string"
        ? node["value"]
        : undefined
    : undefined;
const sourceOf = (node: AstNode): string | undefined => nameOf(node["source"]);

/** How a module's code reaches others: as a barrel of re-exports, or as code using its imports. */
function readModule(code: string): { barrel?: Barrel; edges: Edge[] } | undefined {
  let body: AstNode[];
  try {
    body = astNodes((parseAst(code) as unknown as AstNode)["body"]);
  } catch {
    return undefined;
  }
  const edges: Edge[] = [];
  const barrel: Barrel = { named: new Map(), stars: [] };
  let reexportsOnly = true;
  for (const node of body) {
    const source = sourceOf(node);
    if (node.type === "ImportDeclaration" && source !== undefined) {
      const names = new Set<string>();
      let whole = false;
      for (const specifier of astNodes(node["specifiers"])) {
        if (specifier.type === "ImportSpecifier") {
          const name = nameOf(specifier["imported"]);
          if (name) names.add(name);
        } else if (specifier.type === "ImportDefaultSpecifier") names.add("default");
        else whole = true;
      }
      // A bare `import "./x.ts"` runs the module for its effects: all of it stays.
      edges.push({ source, wanted: whole || names.size === 0 ? "all" : names });
      reexportsOnly = false;
    } else if (node.type === "ExportNamedDeclaration" && source !== undefined) {
      for (const specifier of astNodes(node["specifiers"])) {
        const local = nameOf(specifier["local"]);
        const exported = nameOf(specifier["exported"]);
        if (local && exported) barrel.named.set(exported, { source, wanted: new Set([local]) });
      }
      edges.push({ source, wanted: "all" });
    } else if (node.type === "ExportAllDeclaration" && source !== undefined) {
      const exported = nameOf(node["exported"]);
      if (exported) barrel.named.set(exported, { source, wanted: "all" });
      else barrel.stars.push(source);
      edges.push({ source, wanted: "all" });
    } else reexportsOnly = false;
  }
  return reexportsOnly ? { barrel, edges } : { edges };
}

const withoutQuery = (id: string) => id.replace(/\?.*$/, "");

/** The id an import's specifier resolved to among the module's static imports, if it can tell. */
function resolvedId(importer: string, source: string, importedIds: readonly string[]) {
  const ids = importedIds.map(withoutQuery);
  const match = (test: (id: string) => boolean) => {
    const found = importedIds.filter((_, index) => test(ids[index] ?? ""));
    return found.length === 1 ? found[0] : undefined;
  };
  if (source.startsWith(".")) {
    const target = posix.normalize(posix.join(posix.dirname(withoutQuery(importer)), source));
    return match((id) => id === target);
  }
  if (source.startsWith("@/")) return match((id) => id.endsWith(`/src/${source.slice(2)}`));
  const workspace = source.match(/^@ace\/([^/]+)$/)?.[1];
  return workspace ? match((id) => id.includes(`/packages/${workspace}/src/index.`)) : undefined;
}

/**
 * Every icon the app modules statically reachable from `root` import. The walk follows static
 * imports only and stays out of `node_modules`: what loads through `import()` loads later, as
 * its own entry. Through a barrel it follows only the re-exports of names actually imported
 * from it, so a page that takes one export of a feature's `index.ts` doesn't count every icon
 * the rest of that feature draws; an import it can't trace is followed whole.
 */
function iconsReachedFrom(root: string, info: (id: string) => ModuleInfo | null): Set<string> {
  const icons = new Set<string>();
  const seen = new Map<string, Wanted>();
  const queue: { id: string; wanted: Wanted }[] = [{ id: root, wanted: "all" }];
  for (const { id, wanted } of queue) {
    if (/[\\/]node_modules[\\/]/.test(id)) continue;
    const before = seen.get(id);
    if (before === "all") continue;
    const fresh =
      wanted === "all" ? wanted : new Set([...wanted].filter((name) => !before?.has(name)));
    if (fresh !== "all" && fresh.size === 0) continue;
    seen.set(id, fresh === "all" || !before ? fresh : new Set([...before, ...fresh]));
    const module = info(id);
    if (!module) continue;
    const code = module.code ?? "";
    const read = readModule(code);
    const follow = (source: string, next: Wanted) => {
      const target = resolvedId(id, source, module.importedIds);
      if (target) queue.push({ id: target, wanted: next });
      return target;
    };
    if (read?.barrel && fresh !== "all") {
      const { barrel } = read;
      for (const name of fresh) {
        const edge = barrel.named.get(name);
        if (!edge) continue;
        if (edge.source === "@phosphor-icons/react") {
          if (edge.wanted !== "all")
            for (const icon of edge.wanted) icons.add(icon.replace(/Icon$/, ""));
          continue;
        }
        if (!follow(edge.source, edge.wanted)) queue.push(...whole(module.importedIds));
      }
      // A name the barrel doesn't list by name may come through any `export *`.
      const unnamed = new Set([...fresh].filter((name) => !barrel.named.has(name)));
      if (unnamed.size)
        for (const source of barrel.stars)
          if (!follow(source, unnamed)) queue.push(...whole(module.importedIds));
      continue;
    }
    for (const name of importedIconNames(code)) icons.add(name);
    seen.set(id, "all");
    const traced = new Set<string>();
    for (const edge of read?.edges ?? []) {
      const target = follow(edge.source, edge.wanted);
      if (target) traced.add(target);
    }
    for (const imported of module.importedIds)
      if (!traced.has(imported)) queue.push({ id: imported, wanted: "all" });
  }
  return icons;
}

const whole = (ids: readonly string[]) => ids.map((id) => ({ id, wanted: "all" as const }));

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
