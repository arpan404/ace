/*
 * ace's own lint rules, loaded by oxlint as a JS plugin (`scripts/oxlint/zod-schemas.json`, run by
 * `scripts/check-zod-schemas.ts`).
 *
 * `zod-schema-in-function`: a Zod schema built inside a function is rebuilt on every call, and
 * Zod 4 compiles a fresh parser for each new object schema. On a path that runs per event, row,
 * message or request that is the daemon's biggest allocation cost. Build schemas once at module
 * level. Code that genuinely runs once (startup, migrations, a CLI command) can say so with
 * `// oxlint-disable-next-line ace/zod-schema-in-function -- <why it runs once>`.
 *
 * Flagged inside a function body:
 * - a builder (`object`, `strictObject`, `looseObject`, `array`, `union`, `discriminatedUnion`)
 *   called on Zod however it was imported: `z.object`, `schema.object` after
 *   `import { z as schema }`, `import * as z from "zod/mini"`, a named `object` import, or
 *   `const { z } = await import("zod")`;
 * - a shape method (`extend`, `safeExtend`, `pick`, `omit`, `merge`, `partial`, `required`) called
 *   on a schema this module defines at its top level. Schemas imported from another module are
 *   not tracked: their names say nothing reliable about being schemas, and guessing from names
 *   flags unrelated `.extend()` and `.pick()` calls.
 *
 * Cases the rule must and must not flag: `scripts/oxlint/zod-rule-cases.ts`.
 */
const zodSources = new Set(["zod", "zod/v4", "zod/mini", "zod/v4/mini"]);
const builders = new Set([
  "object",
  "strictObject",
  "looseObject",
  "array",
  "union",
  "discriminatedUnion",
]);
const shapeMethods = new Set([
  "extend",
  "safeExtend",
  "pick",
  "omit",
  "merge",
  "partial",
  "required",
]);
const functionTypes = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

function insideFunction(node) {
  for (let parent = node.parent; parent; parent = parent.parent)
    if (functionTypes.has(parent.type)) return true;
  return false;
}

function propertyName(member) {
  if (member.computed)
    return member.property.type === "Literal" ? member.property.value : undefined;
  return member.property.type === "Identifier" ? member.property.name : undefined;
}

/** @type {import("eslint").Rule.RuleModule} */
const zodSchemaInFunction = {
  meta: {
    type: "problem",
    messages: {
      built:
        "`{{name}}()` inside a function builds and compiles a new schema on every call; hoist it to a module-level constant.",
    },
  },
  create(context) {
    /** Local names bound to the Zod namespace. */
    const namespaces = new Set();
    /** Local names bound to a Zod builder imported by name, mapped to that builder. */
    const namedBuilders = new Map();
    /** Top-level constants holding a schema this module built. */
    const schemas = new Set();

    /** The Zod builder a call invokes, if any: `z.object(...)` or a named `object(...)`. */
    const builderOf = (call) => {
      const callee = call.callee;
      if (callee.type === "Identifier") return namedBuilders.get(callee.name);
      if (callee.type !== "MemberExpression" || callee.object.type !== "Identifier") return;
      if (!namespaces.has(callee.object.name)) return;
      const name = propertyName(callee);
      return builders.has(name) ? name : undefined;
    };
    /** Whether an expression is a schema built from Zod or from a known module schema. */
    const isSchema = (node) => {
      while (node.type === "CallExpression" && node.callee.type === "MemberExpression") {
        if (builderOf(node)) return true;
        node = node.callee.object;
      }
      if (node.type === "CallExpression") return builderOf(node) !== undefined;
      if (node.type === "MemberExpression") {
        // `z.string`, `z.number` and other Zod members chained into a schema.
        return node.object.type === "Identifier" && namespaces.has(node.object.name);
      }
      return node.type === "Identifier" && schemas.has(node.name);
    };

    const readImport = (node) => {
      if (!zodSources.has(node.source.value) || node.importKind === "type") return;
      for (const specifier of node.specifiers) {
        if (specifier.importKind === "type") continue;
        if (specifier.type !== "ImportSpecifier") {
          namespaces.add(specifier.local.name);
          continue;
        }
        const imported =
          specifier.imported.type === "Identifier"
            ? specifier.imported.name
            : specifier.imported.value;
        if (imported === "z") namespaces.add(specifier.local.name);
        else if (builders.has(imported)) namedBuilders.set(specifier.local.name, imported);
      }
    };
    const readDeclaration = (node) => {
      if (node?.type !== "VariableDeclaration") return;
      for (const declarator of node.declarations)
        if (declarator.id.type === "Identifier" && declarator.init && isSchema(declarator.init))
          schemas.add(declarator.id.name);
    };

    return {
      // Imports and top-level schemas first, so a function above a schema still sees it.
      Program(program) {
        for (const statement of program.body)
          if (statement.type === "ImportDeclaration") readImport(statement);
        for (const statement of program.body)
          readDeclaration(
            statement.type === "ExportNamedDeclaration" ? statement.declaration : statement,
          );
      },
      // `const { z } = await import("zod")`, as code that loads Zod lazily writes it.
      VariableDeclarator(node) {
        let init = node.init;
        if (init?.type === "AwaitExpression") init = init.argument;
        if (init?.type !== "ImportExpression" || !zodSources.has(init.source.value)) return;
        if (node.id.type !== "ObjectPattern") return;
        for (const property of node.id.properties) {
          if (property.type !== "Property" || property.value.type !== "Identifier") continue;
          const imported =
            property.key.type === "Identifier" ? property.key.name : property.key.value;
          if (imported === "z") namespaces.add(property.value.name);
          else if (builders.has(imported)) namedBuilders.set(property.value.name, imported);
        }
      },
      CallExpression(node) {
        if (!insideFunction(node)) return;
        const builder = builderOf(node);
        if (builder) {
          context.report({ node, messageId: "built", data: { name: builder } });
          return;
        }
        // A shape method on a schema the module already built. Chains rooted in a builder call
        // inside this function are reported once, at the builder.
        const callee = node.callee;
        if (callee.type !== "MemberExpression") return;
        const method = propertyName(callee);
        if (!shapeMethods.has(method)) return;
        let root = callee.object;
        while (root.type === "CallExpression" && root.callee.type === "MemberExpression") {
          // `A.extend(...).partial()` is one new schema: report it once, at the first method.
          if (shapeMethods.has(propertyName(root.callee))) return;
          root = root.callee.object;
        }
        if (root.type === "Identifier" && schemas.has(root.name))
          context.report({ node, messageId: "built", data: { name: method } });
      },
    };
  },
};

export default {
  meta: { name: "ace" },
  rules: { "zod-schema-in-function": zodSchemaInFunction },
};
