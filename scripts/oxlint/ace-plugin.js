/*
 * ace's own lint rules, loaded by oxlint as a JS plugin (`.oxlintrc.json`).
 *
 * `zod-schema-in-function`: a Zod schema built inside a function is rebuilt on every call, and
 * Zod 4 compiles a fresh parser for each new object schema. On a path that runs per event, row,
 * message or request that is the daemon's biggest allocation cost. Build schemas once at module
 * level. Code that genuinely runs once (startup, migrations, a CLI command) can say so with
 * `// oxlint-disable-next-line ace/zod-schema-in-function -- <why it runs once>`.
 */
const builders = new Set([
  "object",
  "strictObject",
  "looseObject",
  "array",
  "union",
  "discriminatedUnion",
]);

const functionTypes = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

/** @type {import("eslint").Rule.RuleModule} */
const zodSchemaInFunction = {
  meta: {
    type: "problem",
    messages: {
      built:
        "`z.{{name}}()` inside a function builds and compiles a new schema on every call; hoist it to a module-level constant.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type !== "MemberExpression" ||
          callee.object.type !== "Identifier" ||
          callee.object.name !== "z" ||
          callee.property.type !== "Identifier" ||
          !builders.has(callee.property.name)
        )
          return;
        for (let parent = node.parent; parent; parent = parent.parent)
          if (functionTypes.has(parent.type)) {
            context.report({ node, messageId: "built", data: { name: callee.property.name } });
            return;
          }
      },
    };
  },
};

export default {
  meta: { name: "ace" },
  rules: { "zod-schema-in-function": zodSchemaInFunction },
};
