import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { Plugin } from "vite";
import { parseAst } from "vite";

/**
 * The Phosphor weights the design uses (ADR 0056): regular when inactive, fill when active,
 * duotone for empty states, bold for a few glyphs. Every Phosphor icon ships all six weights;
 * dropping `thin` and `light` takes a third of each icon's paths out of every chunk.
 */
export const iconWeights = ["regular", "fill", "duotone", "bold"] as const;
export type UsedIconWeight = (typeof iconWeights)[number];

const defsModule = /@phosphor-icons\/react\/dist\/defs\/([^/]+)\.es\.js$/;

/**
 * Glyph tables that draw their icons in fewer weights, keyed by their path under `apps/web`.
 * Each table pins the weight it draws whatever its caller asks (`file-icon.ts` draws regular,
 * `project-glyphs.ts` bold in a project's mark and regular in the chooser), so an icon that only
 * these tables import keeps only these weights: a file-type mark carries one weight, not four.
 */
export const glyphTables: Readonly<Record<string, readonly UsedIconWeight[]>> = {
  "src/components/file-icon.ts": ["regular"],
  "src/components/project-glyphs.ts": ["regular", "bold"],
};

const phosphor = /["']@phosphor-icons\/react(?:\/[^"']*)?["']/g;
const named =
  /\b(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']@phosphor-icons\/react["']/g;

/**
 * The icons a module's source names from Phosphor, without the `Icon` suffix; undefined when it
 * reaches Phosphor some other way (a namespace import, `export *`, a deep path), which could
 * draw any icon in any weight.
 */
export function phosphorNames(code: string): string[] | undefined {
  const statements = [...code.matchAll(named)];
  if (statements.length !== [...code.matchAll(phosphor)].length) return undefined;
  return statements.flatMap((statement) =>
    (statement[1] ?? "").split(",").flatMap((specifier) => {
      const name = specifier
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+/)[0];
      return name && name !== "Icon" ? [name.replace(/Icon$/, "")] : [];
    }),
  );
}

/**
 * The weights each icon keeps when only glyph tables import it: the union of those tables'.
 * `sources` maps a module's path under `apps/web` (`../../packages/...` for packages) to its code.
 */
export function tableWeights(
  sources: ReadonlyMap<string, string>,
  tables: Readonly<Record<string, readonly string[]>> = glyphTables,
): Map<string, Set<string>> {
  const users = new Map<string, Set<string>>();
  for (const [path, code] of sources) {
    const names = phosphorNames(code);
    if (!names) return new Map();
    for (const name of names) users.set(name, (users.get(name) ?? new Set()).add(path));
  }
  const weights = new Map<string, Set<string>>();
  for (const [name, paths] of users) {
    const kept = [...paths].map((path) => tables[path]);
    if (kept.every((table) => table !== undefined)) weights.set(name, new Set(kept.flat()));
  }
  return weights;
}

/** Every source module of the web app and the packages it builds from, tests left out. */
function readSources(web: string): Map<string, string> {
  const sources = new Map<string, string>();
  const packages = join(web, "../../packages");
  const roots = [
    join(web, "src"),
    ...readdirSync(packages, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(packages, entry.name, "src")),
  ];
  for (const root of roots) {
    let files: string[];
    try {
      files = readdirSync(root, { recursive: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const file of files)
      if (/\.(?:ts|tsx|js|jsx|mjs)$/.test(file) && !/\.test\.|\.d\.ts$/.test(file)) {
        const path = join(root, file);
        sources.set(relative(web, path), readFileSync(path, "utf8"));
      }
  }
  return sources;
}

interface Node {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}
const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && "type" in value && "start" in value;

/** The `new Map([[weight, element], ...])` an icon's defs module exports. */
function weightTable(node: Node): Node | undefined {
  if (node.type === "NewExpression") {
    const callee = node.callee;
    const [table] = Array.isArray(node.arguments) ? node.arguments : [];
    if (
      isNode(callee) &&
      callee.name === "Map" &&
      isNode(table) &&
      table.type === "ArrayExpression"
    )
      return table;
  }
  for (const value of Object.values(node)) {
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) {
      if (!isNode(child)) continue;
      const found = weightTable(child);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Removes the weights the app never draws from each Phosphor icon definition: `thin` and `light`
 * from every icon, and the others from icons only glyph tables draw (`glyphTables`).
 */
export function phosphorWeights(keep: readonly string[] = iconWeights): Plugin {
  const everywhere = new Set(keep);
  let tables = new Map<string, Set<string>>();
  return {
    name: "ace:phosphor-weights",
    enforce: "pre",
    buildStart() {
      tables = tableWeights(readSources(import.meta.dirname));
    },
    transform(code, id) {
      const icon = id.match(defsModule)?.[1];
      if (!icon) return null;
      const kept = tables.get(icon) ?? everywhere;
      const table = weightTable(parseAst(code) as unknown as Node);
      if (!table || !Array.isArray(table.elements)) return null;
      const entries = table.elements.filter(isNode).filter((entry) => {
        const [weight] = Array.isArray(entry.elements) ? entry.elements : [];
        return !(isNode(weight) && typeof weight.value === "string" && !kept.has(weight.value));
      });
      const body = entries.map((entry) => code.slice(entry.start, entry.end)).join(",\n");
      return { code: `${code.slice(0, table.start)}[${body}]${code.slice(table.end)}`, map: null };
    },
  };
}
