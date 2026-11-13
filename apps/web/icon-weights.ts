import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Plugin } from "vite";
import { parseAst } from "vite";
import { weightProblems } from "./icon-weight-guard.ts";

/**
 * The Phosphor weights any icon is drawn in (ADR 0056): regular when inactive, fill when active,
 * bold for a few glyphs. Every Phosphor icon ships six; dropping `thin`, `light` and `duotone`
 * takes half of each icon's paths out of every chunk. Duotone, for empty states, stays only in
 * the glyphs of the empty-state table (`glyphTables`).
 */
export const iconWeights = ["regular", "fill", "bold"] as const;
export type UsedIconWeight = (typeof iconWeights)[number];
/** The weights a glyph table may draw in. */
export type TableWeight = UsedIconWeight | "duotone";

const defsModule = /@phosphor-icons\/react\/dist\/defs\/([^/]+)\.es\.js$/;

/**
 * Glyph tables that draw their icons in set weights, keyed by their path under `apps/web`. Each
 * table pins the weight it draws whatever its caller asks (`pinnedGlyph`): `file-icon.ts` draws
 * regular, `project-glyphs.ts` bold in a project's mark and regular in the chooser,
 * `empty-glyphs.ts` duotone. An icon that only tables import keeps only their weights, so a
 * file-type mark carries one weight, not three; an icon others import too keeps every weight in
 * `iconWeights` plus its tables'.
 */
export const glyphTables: Readonly<Record<string, readonly TableWeight[]>> = {
  "src/components/file-icon.ts": ["regular"],
  "src/components/project-glyphs.ts": ["regular", "bold"],
  "src/components/empty-glyphs.ts": ["duotone"],
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
 * The weights each icon imported by a glyph table keeps: its tables' weights, and `base` too when
 * any other module imports it. `sources` maps a module's path under `apps/web`
 * (`../../packages/...` for packages) to its code. With a module that reaches Phosphor some other
 * way, every icon keeps `base` and every table weight.
 */
export function tableWeights(
  sources: ReadonlyMap<string, string>,
  tables: Readonly<Record<string, readonly string[]>> = glyphTables,
  base: readonly string[] = iconWeights,
): { weights: Map<string, Set<string>>; fallback: Set<string> } {
  const everything = new Set([...base, ...Object.values(tables).flat()]);
  const users = new Map<string, Set<string>>();
  for (const [path, code] of sources) {
    const names = phosphorNames(code);
    if (!names) return { weights: new Map(), fallback: everything };
    for (const name of names) users.set(name, (users.get(name) ?? new Set()).add(path));
  }
  const weights = new Map<string, Set<string>>();
  for (const [name, paths] of users) {
    const kept = [...paths].map((path) => tables[path]);
    const only = kept.every((table) => table !== undefined);
    if (only || kept.some((table) => table !== undefined))
      weights.set(name, new Set([...(only ? [] : base), ...kept.flatMap((table) => table ?? [])]));
  }
  return { weights, fallback: new Set(base) };
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
        // Keyed with "/" on every OS, as glyphTables and the guard's exemptions are.
        sources.set(relative(web, path).split(sep).join("/"), readFileSync(path, "utf8"));
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
 * Removes the weights the app never draws from each Phosphor icon definition: those outside
 * `iconWeights` from every icon but a glyph table's (`glyphTables`), and from an icon only tables
 * draw, every weight they don't.
 */
export function phosphorWeights(): Plugin {
  let kept = tableWeights(new Map());
  return {
    name: "ace:phosphor-weights",
    enforce: "pre",
    buildStart() {
      const sources = readSources(import.meta.dirname);
      const problems = weightProblems(
        sources,
        (path) => new Set([...iconWeights, ...(glyphTables[path] ?? [])]),
      );
      if (problems.length)
        this.error(
          `An icon asked for a weight the build may drop draws nothing (icon-weights.ts). Spell its weight out as one of ${iconWeights.join(", ")}, or draw it through a glyph table:\n${problems.join("\n")}`,
        );
      kept = tableWeights(sources);
    },
    transform(code, id) {
      const icon = id.match(defsModule)?.[1];
      if (!icon) return null;
      const weights = kept.weights.get(icon) ?? kept.fallback;
      const table = weightTable(parseAst(code) as unknown as Node);
      if (!table || !Array.isArray(table.elements)) return null;
      const entries = table.elements.filter(isNode).filter((entry) => {
        const [weight] = Array.isArray(entry.elements) ? entry.elements : [];
        return !(isNode(weight) && typeof weight.value === "string" && !weights.has(weight.value));
      });
      const body = entries.map((entry) => code.slice(entry.start, entry.end)).join(",\n");
      return { code: `${code.slice(0, table.start)}[${body}]${code.slice(table.end)}`, map: null };
    },
  };
}
