import { parseAst } from "vite";

/*
 * The build keeps only some weights of each Phosphor icon (`icon-weights.ts`); an icon asked for
 * another draws no paths at all. This reads every place a module sets an icon's weight and names
 * each one that asks for a dropped weight, or whose weight can't be read from the source.
 */

/**
 * Modules whose weight values are typed to the weights the build keeps (`UsedIconWeight`,
 * `TableWeight`), so a value read from a variable there is still one the build keeps: the `Icon`
 * component and `pinnedGlyph`, and the row status table.
 */
export const typedWeightModules = new Set([
  "src/components/icon.tsx",
  "src/components/status-icons.tsx",
]);
/** ace's own icons, which take Phosphor's weight names but draw their own paths. */
const ownPaths = new Set(["src/components/ace-icons.tsx"]);

interface Node {
  type: string;
  start: number;
  [key: string]: unknown;
}
const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as Node).type === "string";
const children = (node: Node): Node[] =>
  Object.entries(node).flatMap(([key, value]) =>
    key === "parent"
      ? []
      : Array.isArray(value)
        ? value.filter(isNode)
        : isNode(value)
          ? [value]
          : [],
  );

/** Every weight an expression can be, or undefined when the source doesn't say. */
function weightsOf(node: unknown): string[] | undefined {
  if (!isNode(node)) return undefined;
  switch (node.type) {
    case "Literal":
      return typeof node["value"] === "string" ? [node["value"]] : undefined;
    case "TemplateLiteral": {
      // Only a template without `${…}` spells out its value.
      const quasis = Array.isArray(node["quasis"]) ? node["quasis"].filter(isNode) : [];
      const value = quasis[0]?.["value"];
      const plain = Array.isArray(node["expressions"]) && node["expressions"].length === 0;
      return plain && typeof value === "object" && value !== null && "cooked" in value
        ? typeof value.cooked === "string"
          ? [value.cooked]
          : undefined
        : undefined;
    }
    case "ConditionalExpression":
    case "LogicalExpression": {
      const sides =
        node.type === "LogicalExpression"
          ? [node["left"], node["right"]]
          : [node["consequent"], node["alternate"]];
      const each = sides.map(weightsOf);
      return each.every((side) => side !== undefined) ? each.flat() : undefined;
    }
    case "ParenthesizedExpression":
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
      return weightsOf(node["expression"]);
    case "JSXExpressionContainer":
      return weightsOf(node["expression"]);
    default:
      return undefined;
  }
}

const keyName = (node: unknown): string | undefined =>
  isNode(node)
    ? (node.type === "Identifier" || node.type === "JSXIdentifier") &&
      typeof node["name"] === "string"
      ? node["name"]
      : node.type === "Literal" && typeof node["value"] === "string"
        ? node["value"]
        : undefined
    : undefined;

/** The names a module gives the icons it imports from Phosphor. */
function phosphorLocals(body: Node[]): Set<string> {
  const locals = new Set<string>();
  for (const node of body) {
    const source = node["source"];
    if (node.type !== "ImportDeclaration" || !isNode(source)) continue;
    if (source["value"] !== "@phosphor-icons/react") continue;
    for (const specifier of Array.isArray(node["specifiers"]) ? node["specifiers"] : [])
      if (isNode(specifier) && isNode(specifier["local"]))
        locals.add(String(specifier["local"]["name"]));
  }
  return locals;
}

/**
 * Each place in `sources` (path under `apps/web` to code) that asks an icon for a weight outside
 * `kept(path)`, or sets one the source can't tell (a variable, a call, props spread onto an icon).
 */
export function weightProblems(
  sources: ReadonlyMap<string, string>,
  kept: (path: string) => ReadonlySet<string>,
): string[] {
  const problems: string[] = [];
  for (const [path, code] of sources) {
    if (ownPaths.has(path) || !/weight/i.test(code)) continue;
    let program: Node;
    try {
      const parsed: unknown = parseAst(code, { lang: path.endsWith("x") ? "tsx" : "ts" });
      if (!isNode(parsed)) continue;
      program = parsed;
    } catch {
      problems.push(`${path}: couldn't be read to check its icon weights`);
      continue;
    }
    const allowed = kept(path);
    const typed = typedWeightModules.has(path);
    const icons = phosphorLocals(
      Array.isArray(program["body"]) ? program["body"].filter(isNode) : [],
    );
    const at = (node: Node) => `${path}:${code.slice(0, node.start).split("\n").length}`;
    const check = (node: Node, weights: string[]) => {
      for (const weight of weights)
        if (!allowed.has(weight))
          problems.push(`${at(node)} asks an icon for "${weight}", a weight the build drops`);
    };
    const visit = (node: Node) => {
      if (node.type === "JSXOpeningElement") {
        const name = isNode(node["name"])
          ? code.slice(node["name"].start, Number(node["name"]["end"]))
          : "";
        for (const attribute of Array.isArray(node["attributes"])
          ? node["attributes"].filter(isNode)
          : []) {
          if (attribute.type === "JSXSpreadAttribute") {
            if (icons.has(name) && !typed)
              problems.push(
                `${at(attribute)} spreads props onto <${name}>, so its weight can't be read`,
              );
            continue;
          }
          if (keyName(attribute["name"]) !== "weight") continue;
          const weights = weightsOf(attribute["value"]);
          if (weights) check(attribute, weights);
          else if (!typed)
            problems.push(
              `${at(attribute)} sets <${name}>'s weight to a value the source doesn't spell out`,
            );
        }
      }
      // An object's `weight` (an icon table's entry); one that isn't a string (a cache's byte
      // weight) is no icon's.
      if (node.type === "ObjectExpression")
        for (const property of Array.isArray(node["properties"])
          ? node["properties"].filter(isNode)
          : [])
          if (property.type === "Property" && keyName(property["key"]) === "weight") {
            const weights = weightsOf(property["value"]);
            if (weights) check(property, weights);
          }
      for (const child of children(node)) visit(child);
    };
    visit(program);
  }
  return problems;
}
