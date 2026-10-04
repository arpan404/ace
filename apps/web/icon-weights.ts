import type { Plugin } from "vite";
import { parseAst } from "vite";

/**
 * The Phosphor weights the design uses (ADR 0056): regular when inactive, fill when active,
 * duotone for empty states, bold for a few glyphs. Every Phosphor icon ships all six weights;
 * dropping `thin` and `light` takes a third of each icon's paths out of every chunk.
 */
export const iconWeights = ["regular", "fill", "duotone", "bold"] as const;
export type UsedIconWeight = (typeof iconWeights)[number];

const defsModule = /@phosphor-icons\/react\/dist\/defs\/[^/]+\.es\.js$/;

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

/** Removes the weights the app never draws from each Phosphor icon definition. */
export function phosphorWeights(keep: readonly string[] = iconWeights): Plugin {
  const kept = new Set(keep);
  return {
    name: "ace:phosphor-weights",
    enforce: "pre",
    transform(code, id) {
      if (!defsModule.test(id)) return null;
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
