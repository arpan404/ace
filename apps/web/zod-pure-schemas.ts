import { MagicString } from "magic-string";
import type { Plugin } from "vite";

interface Node {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}
const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";

/**
 * Protocol modules and the listed worker wire/target modules contain only schemas and pure helpers. Constructing an unused schema has
 * no observable effect on parsing another schema. A pure factory around each initializer lets
 * Rolldown discard the whole construction, including spreads of another schema's shape/options
 * which it otherwise conservatively keeps as potentially effectful property reads.
 *
 * This runs after metadata stripping and never annotates calls inside parsers or refinements.
 */
export function zodPureSchemas(): Plugin {
  return {
    name: "ace:zod-pure-schemas",
    transform(code, id) {
      const schemaModule =
        /\/packages\/protocol\/src\/[^?]*\.ts(?:\?|$)/.test(id) ||
        /\/packages\/client-worker\/src\/wire\.ts(?:\?|$)/.test(id) ||
        /\/apps\/web\/src\/boot\/(worker-target|machine-target|connection-settings)\.ts(?:\?|$)/.test(
          id,
        );
      if (!schemaModule) return null;
      const out = new MagicString(code);
      const program: unknown = this.parse(code);
      if (!isNode(program) || !Array.isArray(program["body"])) return null;
      for (const statement of program["body"]) {
        if (!isNode(statement)) continue;
        const declaration =
          statement.type === "ExportNamedDeclaration" ? statement["declaration"] : statement;
        if (
          !isNode(declaration) ||
          declaration.type !== "VariableDeclaration" ||
          declaration["kind"] !== "const" ||
          !Array.isArray(declaration["declarations"])
        )
          continue;
        for (const binding of declaration["declarations"]) {
          if (!isNode(binding)) continue;
          const init = binding["init"];
          if (
            !isNode(init) ||
            !["CallExpression", "ArrayExpression", "ObjectExpression", "NewExpression"].includes(
              init.type,
            )
          )
            continue;
          out.prependLeft(init.start, "/* @__PURE__ */ (() => (");
          out.appendLeft(init.end, "))()");
        }
      }
      return { code: out.toString(), map: out.generateMap({ hires: true, source: id }) };
    },
  };
}
