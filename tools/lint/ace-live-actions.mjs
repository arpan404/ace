/*
 * `ace/live-actions`: every action on what a thread copy shows (an answer, a Stop, a queue
 * change, a send-now steer, an archive, a delete) is built and sent by
 * apps/web/src/lib/live-actions.ts, which checks the copy is current as it sends. Anywhere else
 * in the web app, naming one of those commands as a value (any quotes, in a variable or an
 * object), or a `delivery` of "steer", is an error: a new sender can't skip the gate. So is
 * using a helper from another package that sends one of them (`helpers`). Types and comments
 * may name them.
 */

const commands = new Set([
  "interaction.resolve",
  "thread.interrupt",
  "background_task.stop",
  "queue.edit",
  "queue.remove",
  "queue.move",
  "queue.resend",
  "queue.cancel",
  "queue.steer",
  "queue.pause",
  "queue.resume",
  "queue.clear",
  "thread.archive",
  "thread.delete",
]);

/**
 * Helpers in other packages that build or send those commands on the web app's behalf: using
 * one outside live-actions.ts skips its gate just as a raw command would.
 */
const helpers = new Set([
  // @ace/client: a failed send's Retry, which resumes the thread's queue.
  "retrySend",
  // @ace/ui-core: a queue-wide action's command (resume, pause, a limit choice).
  "queueActionPayload",
]);

/** Files that may name them: the gated module itself, and tests. */
const allowed = (filename) =>
  filename.endsWith("apps/web/src/lib/live-actions.ts") ||
  /\.test\.tsx?$/.test(filename) ||
  /apps\/web\/src\/test\//.test(filename);

/** TypeScript nodes that wrap a value rather than a type. */
const valueWrappers = new Set(["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression"]);

/** Inside a TypeScript type (`type: "queue.edit"` in a union, a literal type): not a value. */
function inType(node) {
  for (let at = node.parent; at; at = at.parent) {
    if (typeof at.type === "string" && at.type.startsWith("TS") && !valueWrappers.has(at.type))
      return true;
  }
  return false;
}

const message = (name) =>
  `Send "${name}" through apps/web/src/lib/live-actions.ts, which checks the copy is current as it sends.`;

const rule = {
  meta: { type: "problem", docs: { description: "Live actions go through live-actions.ts" } },
  create(context) {
    const filename = context.filename ?? context.getFilename?.() ?? "";
    if (allowed(filename)) return {};
    const check = (node, value) => {
      if (typeof value !== "string" || inType(node)) return;
      if (commands.has(value)) context.report({ node, message: message(value) });
      else if (
        value === "steer" &&
        node.parent?.type === "Property" &&
        node.parent.value === node &&
        ((node.parent.key?.type === "Identifier" && node.parent.key.name === "delivery") ||
          node.parent.key?.value === "delivery")
      )
        context.report({ node, message: message('delivery: "steer"') });
    };
    const helper = (node, name) => {
      if (helpers.has(name))
        context.report({
          node,
          message: `Use live-actions.ts instead of ${name}: it checks the copy is current as it sends.`,
        });
    };
    return {
      ImportSpecifier(node) {
        helper(node, node.imported?.name ?? node.imported?.value);
      },
      MemberExpression(node) {
        if (!node.computed && node.property?.type === "Identifier")
          helper(node, node.property.name);
      },
      Literal(node) {
        check(node, node.value);
      },
      TemplateLiteral(node) {
        if (node.expressions.length === 0) check(node, node.quasis[0]?.value?.cooked);
      },
    };
  },
};

export default { meta: { name: "ace" }, rules: { "live-actions": rule } };
