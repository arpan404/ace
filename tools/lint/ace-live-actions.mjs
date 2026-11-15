/*
 * `ace/live-actions`: every action on what a thread copy shows (an answer, a Stop, a queue
 * change, a send-now steer, an archive, a delete) is built and sent by
 * apps/web/src/lib/live-actions.ts, which checks the copy is current as it sends. Anywhere else
 * in the web app, naming one of those commands as a value (any quotes, in a variable or an
 * object), or a `delivery` of "steer", is an error: a new sender can't skip the gate. So is
 * using a helper from another package that sends one of them (`helpers`). Types and comments
 * may name them.
 *
 * `ace/live-words`: the ui-core formatters that put agent, subagent, step, task or thread state
 * into words, counts, tones or actions (`formatters`) are used only in files named
 * live-words.ts, whose functions take the copy's freshness first.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

/**
 * ui-core formatters that turn agent, subagent, step, task or thread state into words, counts,
 * tones or actions. In the web app only files named live-words.ts may use them: each wraps one
 * in a function that takes the copy's freshness (`Live`) first and returns the stale words
 * before reading any state, so a component can't format a state without saying whether it is
 * current.
 */
const formatters = new Set([
  "subagentDetail",
  "subagentLabels",
  "subagentGroupTitle",
  "subagentGroupCounts",
  "subagentGroupStatus",
  "subagentOutcome",
  "backgroundGroup",
  "backgroundTaskLine",
  "thoughtLabel",
  "describeActivity",
  "agentWorkState",
  "agentTally",
  "agentTallyParts",
  "agentStatusLabel",
  "agentStep",
  "agentOutcome",
  "threadRowStatus",
  "listTreeFacts",
  "treeWorking",
  "nowLine",
  "queuedDetail",
  "queuedSlotFragment",
  "childAskingLabel",
]);

/** Files that may use the formatters: the live-words modules, and tests. */
const wordsAllowed = (filename) =>
  filename.endsWith("/live-words.ts") ||
  /\.test\.tsx?$/.test(filename) ||
  /apps\/web\/src\/test\//.test(filename);

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

/** A string a property is named by: `x.name`, `x["name"]` or `` x[`name`] ``. */
function memberName(node) {
  const property = node.property;
  if (!node.computed) return property?.type === "Identifier" ? property.name : undefined;
  if (property?.type === "Literal" && typeof property.value === "string") return property.value;
  if (property?.type === "TemplateLiteral" && property.expressions.length === 0)
    return property.quasis[0]?.value?.cooked;
  return undefined;
}

const nameOf = (node) => node?.name ?? node?.value;

/** Whether a module specifier is one of `packages` or a subpath of one. */
const fromPackage = (source, packages) =>
  typeof source === "string" &&
  packages.some((name) => source === name || source.startsWith(`${name}/`));

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
/** Where each gated package lives in the repo. */
const packageDirs = { "@ace/ui-core": "packages/ui-core", "@ace/client": "packages/client" };

/** The file a package specifier names, through its package.json `exports`; else undefined. */
function resolveSpecifier(source) {
  const name = Object.keys(packageDirs).find(
    (candidate) => source === candidate || source.startsWith(`${candidate}/`),
  );
  if (!name) return undefined;
  const dir = join(repo, packageDirs[name]);
  try {
    const exports = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).exports ?? {};
    const entry = exports[`.${source.slice(name.length)}`];
    const target = typeof entry === "string" ? entry : (entry?.import ?? entry?.default);
    return typeof target === "string" ? join(dir, target) : undefined;
  } catch {
    return undefined;
  }
}

const declared =
  /\bexport\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g;
const listed = /\bexport\s*(?:type\s*)?\{([^}]*)\}/g;
const starred = /\bexport\s*\*\s*(?:as\s+[\w$]+\s*)?from\s*["']([^"']+)["']/g;

/** Names a module exports, followed through its own `export *` lines; undefined if unreadable. */
function exportedNames(file, seen = new Set()) {
  if (seen.has(file)) return new Set();
  seen.add(file);
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, "utf8");
  const names = new Set();
  for (const match of text.matchAll(declared)) names.add(match[1]);
  for (const match of text.matchAll(listed))
    for (const part of match[1].split(",")) {
      const exported = part
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.replace(/^type\s+/, "");
      if (exported) names.add(exported);
    }
  for (const match of text.matchAll(starred)) {
    const inner = match[1].startsWith(".")
      ? join(dirname(file), match[1])
      : resolveSpecifier(match[1]);
    const more = inner && exportedNames(inner, seen);
    if (!more) return undefined;
    for (const name of more) names.add(name);
  }
  return names;
}

const passesOnCache = new Map();
/**
 * Whether `export * from source` would pass on any of `names`: the module it names is read and
 * its exports (followed through its own re-exports) checked. One that can't be read counts.
 */
function passesOn(source, names) {
  const key = `${source}\0${[...names].join(",")}`;
  if (!passesOnCache.has(key)) {
    const file = resolveSpecifier(source);
    const exported = file && exportedNames(file);
    passesOnCache.set(key, !exported || [...names].some((name) => exported.has(name)));
  }
  return passesOnCache.get(key);
}

/**
 * Every way a module reaches a listed name besides a call in the open: an import (renamed or
 * not), a property (`ui.name`, `ui["name"]`), a destructured binding (`{ name } = ui`).
 */
function uses(names, report) {
  return {
    ImportSpecifier(node) {
      const name = nameOf(node.imported);
      if (names.has(name)) report(node, name);
    },
    MemberExpression(node) {
      const name = memberName(node);
      if (names.has(name)) report(node, name);
    },
    Property(node) {
      if (node.parent?.type !== "ObjectPattern") return;
      const name = node.computed
        ? node.key?.type === "Literal"
          ? node.key.value
          : undefined
        : nameOf(node.key);
      if (names.has(name)) report(node, name);
    },
  };
}

/**
 * Re-exports that would hand a listed name to modules outside the files allowed it: a named
 * one (`export { name as other } from "pkg"`) or every export of its package (`export *`).
 * Flagged in every file, the allowed ones included: they use the names, they never pass them on.
 */
function reexports(names, packages, report) {
  return {
    ExportNamedDeclaration(node) {
      if (!node.source) return;
      for (const specifier of node.specifiers ?? []) {
        const name = nameOf(specifier.local);
        if (names.has(name)) report(specifier, name);
      }
    },
    ExportAllDeclaration(node) {
      const source = node.source?.value;
      if (fromPackage(source, packages) && passesOn(source, names))
        report(node, `* from "${source}"`);
    },
  };
}

const message = (name) =>
  `Send "${name}" through apps/web/src/lib/live-actions.ts, which checks the copy is current as it sends.`;

/** Packages whose helpers send gated commands. */
const helperPackages = ["@ace/client", "@ace/ui-core"];
/** The package the state formatters come from. */
const formatterPackages = ["@ace/ui-core"];

const rule = {
  meta: { type: "problem", docs: { description: "Live actions go through live-actions.ts" } },
  create(context) {
    const filename = context.filename ?? context.getFilename?.() ?? "";
    const passedOn = (node, name) =>
      context.report({
        node,
        message: `Don't re-export ${name}: it would let a module skip live-actions.ts, which checks the copy is current as it sends.`,
      });
    if (/\.test\.tsx?$/.test(filename) || /apps\/web\/src\/test\//.test(filename)) return {};
    if (allowed(filename)) return reexports(helpers, helperPackages, passedOn);
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
      ...uses(helpers, helper),
      ...reexports(helpers, helperPackages, passedOn),
      Literal(node) {
        check(node, node.value);
      },
      TemplateLiteral(node) {
        if (node.expressions.length === 0) check(node, node.quasis[0]?.value?.cooked);
      },
    };
  },
};

/** `ace/live-words`: state formatters only through a live-words.ts wrapper that takes `Live`. */
const wordsRule = {
  meta: {
    type: "problem",
    docs: { description: "State formatters go through a live-words.ts wrapper" },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename?.() ?? "";
    const report = (node, name) =>
      context.report({
        node,
        message: `Format state through a live-words.ts function that takes \`Live\` first, not ${name}: it shows only the stale words while the copy isn't current.`,
      });
    const passedOn = (node, name) =>
      context.report({
        node,
        message: `Don't re-export ${name}: wrap it in a live-words.ts function that takes \`Live\` first.`,
      });
    if (/\.test\.tsx?$/.test(filename) || /apps\/web\/src\/test\//.test(filename)) return {};
    if (wordsAllowed(filename)) return reexports(formatters, formatterPackages, passedOn);
    return { ...uses(formatters, report), ...reexports(formatters, formatterPackages, passedOn) };
  },
};

export default {
  meta: { name: "ace" },
  rules: { "live-actions": rule, "live-words": wordsRule },
};
