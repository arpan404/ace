import { walk, type JsNode } from "./js-ast.ts";

/*
 * Module identities in a JavaScript or TypeScript parse (ADR 0173 §8). The data-flow rule must
 * know that `e` in `const e = require("process").env` is the environment, the same as a literal
 * `process.env`, and that `readFileSync` imported from `node:fs` is a file read. This module binds
 * local names to the modules they stand for, through `require`, `import` (default, named,
 * namespace, dynamic), destructuring, aliases, `Reflect.get` and `globalThis.process`, and answers
 * which module and member a node reads.
 *
 * It also lists the reads it can't resolve: a sensitive module indexed by a computed key, handed
 * whole to a function, or a `require`/`import` of a name that isn't a literal. The scanner fails
 * closed, so the caller holds a file with one of those beside a sink. Pure; every walk is bounded
 * by the js-ast node cap, and a walk cut short is reported, never taken as complete.
 */

/** The modules whose reads matter: sensitive sources, and the network modules that are sinks. */
export type ModuleId = "process" | "fs" | "os" | "child_process" | "keychain" | "network";
/** The global object (`globalThis`, `global`, `window`, `self`), only a way to reach `process`. */
type Ref = { module: ModuleId | "global"; path: readonly string[] };
/** A module and the member path read off it; `*` is a computed key under `process.env`. */
export interface ModuleRef {
  module: ModuleId;
  path: readonly string[];
}

export const SENSITIVE_MODULES: ReadonlySet<ModuleId> = new Set([
  "process",
  "fs",
  "os",
  "child_process",
  "keychain",
]);

const SPECIFIERS: ReadonlyMap<string, ModuleId> = new Map<string, ModuleId>([
  ["process", "process"],
  ["fs", "fs"],
  ["fs/promises", "fs"],
  ["fs-extra", "fs"],
  ["graceful-fs", "fs"],
  ["os", "os"],
  ["child_process", "child_process"],
  ["execa", "child_process"],
  ["cross-spawn", "child_process"],
  ["keytar", "keychain"],
  ["keychain", "keychain"],
  ["keyring", "keychain"],
  ["@napi-rs/keyring", "keychain"],
  ["http", "network"],
  ["https", "network"],
  ["http2", "network"],
  ["net", "network"],
  ["tls", "network"],
  ["dgram", "network"],
  ["dns", "network"],
  ["dns/promises", "network"],
  ["undici", "network"],
  ["node-fetch", "network"],
  ["cross-fetch", "network"],
  ["axios", "network"],
  ["got", "network"],
  ["ky", "network"],
  ["superagent", "network"],
  ["request", "network"],
  ["ws", "network"],
]);

/** The module a specifier names (`node:` prefix allowed), when it is one the scanner tracks. */
export const moduleOfSpecifier = (specifier: string): ModuleId | undefined =>
  SPECIFIERS.get(specifier.replace(/^node:/, ""));

const GLOBALS = new Set(["globalThis", "global", "window", "self"]);
/** Node wrappers that pass their inner value through unchanged. */
const TRANSPARENT = new Set([
  "AwaitExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TypeCastExpression",
  "ParenthesizedExpression",
  "LogicalExpression",
  "ConditionalExpression",
  "SequenceExpression",
]);
const MAX_PATH = 4;

const asNode = (value: unknown): JsNode | undefined =>
  typeof value === "object" && value !== null && typeof (value as JsNode).type === "string"
    ? (value as JsNode)
    : undefined;
const nameOf = (node: JsNode | undefined): string | undefined =>
  node?.type === "Identifier" && typeof node.name === "string" ? node.name : undefined;

/** A string a node always evaluates to: a string literal or an expression-free template. */
export function literalString(node: JsNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "StringLiteral" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral") {
    const expressions = node.expressions as unknown[] | undefined;
    const quasis = node.quasis as JsNode[] | undefined;
    if ((expressions?.length ?? 0) > 0 || quasis?.length !== 1) return undefined;
    const cooked = (quasis[0]?.value as { cooked?: unknown } | undefined)?.cooked;
    return typeof cooked === "string" ? cooked : undefined;
  }
  return undefined;
}

/** The key a member expression reads, when it is static (`a.b`, `a["b"]`). */
function memberKey(node: JsNode): string | undefined {
  const property = asNode(node.property);
  if (!node.computed) return nameOf(property) ?? literalString(property);
  return literalString(property);
}

/** One unresolved read of a sensitive module (or of a module named by a computed string). */
export interface UnresolvedRead {
  line?: number;
  what: string;
}

export interface ModuleBindings {
  /** Which module and member a node reads, when it is one the scanner tracks. */
  refOf(node: JsNode): ModuleRef | undefined;
  /** Reads off a sensitive module the scanner can't resolve to a member. */
  unresolved: UnresolvedRead[];
  /** Whether a bounded walk was cut short, so the analysis saw only part of the file. */
  truncated: boolean;
  /** Whether a name is bound to a tracked module (so a value-taint map should leave it alone). */
  isBound(name: string): boolean;
}

/**
 * Whether an identifier node is a reference to a binding, not a property name, an object key or
 * a declaration's own name.
 */
export function isReference(node: JsNode, parent: JsNode | undefined): boolean {
  if (node.type !== "Identifier" || !parent) return true;
  switch (parent.type) {
    case "MemberExpression":
    case "OptionalMemberExpression":
      return parent.property !== node || parent.computed === true;
    case "ObjectProperty":
    case "ObjectMethod":
    case "ClassMethod":
    case "ClassProperty":
    case "ClassPrivateProperty":
      return parent.key !== node || parent.computed === true;
    case "ImportSpecifier":
    case "ImportDefaultSpecifier":
    case "ImportNamespaceSpecifier":
    case "ExportSpecifier":
    case "LabeledStatement":
    case "BreakStatement":
    case "ContinueStatement":
    case "TSPropertySignature":
    case "TSQualifiedName":
      return false;
    default:
      return true;
  }
}

/** Whether `call` is `Reflect.get(...)`. */
const isReflectGet = (call: JsNode): boolean => {
  const callee = asNode(call.callee);
  return (
    (callee?.type === "MemberExpression" || callee?.type === "OptionalMemberExpression") &&
    nameOf(asNode(callee.object)) === "Reflect" &&
    memberKey(callee) === "get"
  );
};

const sensitive = (ref: Ref | undefined): ref is ModuleRef =>
  ref !== undefined && ref.module !== "global" && SENSITIVE_MODULES.has(ref.module);
/** A ref that is a whole module (or `fs.promises`), not yet narrowed to one member. */
const whole = (ref: ModuleRef) =>
  ref.path.length === 0 ||
  (ref.module === "fs" && ref.path.length === 1 && ref.path[0] === "promises");

/**
 * Binds the file's local names to the modules they stand for, to a fixpoint, then lists the
 * reads off a sensitive module it can't resolve.
 */
export function bindModules(program: JsNode, walker: typeof walk = walk): ModuleBindings {
  const names = new Map<string, Ref>();
  const requireNames = new Set(["require"]);
  /** Identifier nodes that are a binding's own name, never a read. */
  const declared = new WeakSet<JsNode>();
  const unresolved = new Map<number, UnresolvedRead>();
  let truncated = false;

  const markUnresolved = (node: JsNode, what: string) => {
    const at = node.start ?? -1;
    if (unresolved.has(at)) return;
    const line = node.loc?.start.line;
    unresolved.set(at, { ...(line ? { line } : {}), what });
  };

  const extend = (ref: Ref, key: string): Ref | undefined => {
    if (ref.module === "global") {
      return key === "process" ? { module: "process", path: [] } : undefined;
    }
    if (key === "default" && ref.path.length === 0) return ref;
    if (ref.path.length >= MAX_PATH) return ref;
    return { module: ref.module, path: [...ref.path, key] };
  };

  /** The module a `require`/`import` call names; `null` when its name isn't a literal. */
  const requiredModule = (call: JsNode): ModuleId | undefined | null => {
    const callee = asNode(call.callee);
    const isImport = callee?.type === "Import";
    const isRequire =
      (callee && requireNames.has(nameOf(callee) ?? "")) ||
      ((callee?.type === "MemberExpression" || callee?.type === "OptionalMemberExpression") &&
        memberKey(callee) === "require");
    if (!isImport && !isRequire) return undefined;
    const arg = asNode((call.arguments as unknown[] | undefined)?.[0]);
    const specifier = literalString(arg);
    if (specifier === undefined) return null;
    return moduleOfSpecifier(specifier);
  };

  const rawRef = (input: JsNode, depth = 0): Ref | undefined => {
    if (depth > 32) return undefined;
    const node = input;
    switch (node.type) {
      case "Identifier": {
        const name = nameOf(node) ?? "";
        const bound = names.get(name);
        if (bound) return bound;
        if (name === "process") return { module: "process", path: [] };
        if (GLOBALS.has(name)) return { module: "global", path: [] };
        return undefined;
      }
      case "MemberExpression":
      case "OptionalMemberExpression": {
        const object = asNode(node.object);
        const base = object ? rawRef(object, depth + 1) : undefined;
        if (!base) return undefined;
        const key = memberKey(node);
        if (key !== undefined) return extend(base, key);
        if (base.module === "process" && base.path.length === 1 && base.path[0] === "env")
          return { module: "process", path: ["env", "*"] };
        return undefined;
      }
      case "CallExpression":
      case "OptionalCallExpression": {
        const required = requiredModule(node);
        if (required) return { module: required, path: [] };
        if (isReflectGet(node)) {
          const args = (node.arguments as unknown[] | undefined) ?? [];
          const target = asNode(args[0]);
          const key = literalString(asNode(args[1]));
          const base = target ? rawRef(target, depth + 1) : undefined;
          return base && key !== undefined ? extend(base, key) : undefined;
        }
        return undefined;
      }
      case "ImportExpression": {
        const specifier = literalString(asNode(node.source));
        const id = specifier === undefined ? undefined : moduleOfSpecifier(specifier);
        return id ? { module: id, path: [] } : undefined;
      }
      case "LogicalExpression":
      case "ConditionalExpression": {
        for (const field of ["consequent", "alternate", "left", "right"]) {
          const branch = asNode(node[field]);
          const ref = branch ? rawRef(branch, depth + 1) : undefined;
          if (ref) return ref;
        }
        return undefined;
      }
      case "SequenceExpression": {
        const expressions = node.expressions as unknown[] | undefined;
        const last = asNode(expressions?.at(-1));
        return last ? rawRef(last, depth + 1) : undefined;
      }
      default: {
        if (!TRANSPARENT.has(node.type)) return undefined;
        const inner = asNode(node.expression) ?? asNode(node.argument);
        return inner ? rawRef(inner, depth + 1) : undefined;
      }
    }
  };

  const bindPattern = (pattern: JsNode | undefined, ref: Ref | undefined): boolean => {
    if (!pattern) return false;
    switch (pattern.type) {
      case "Identifier": {
        declared.add(pattern);
        const name = nameOf(pattern);
        if (!name || !ref || names.has(name)) return false;
        names.set(name, ref);
        return true;
      }
      case "ObjectPattern": {
        let changed = false;
        for (const prop of (pattern.properties as unknown[] | undefined) ?? []) {
          const property = asNode(prop);
          if (!property) continue;
          if (property.type === "RestElement") {
            changed = bindPattern(asNode(property.argument), ref) || changed;
            continue;
          }
          if (property.type !== "ObjectProperty") continue;
          const keyNode = asNode(property.key);
          const key = property.computed
            ? literalString(keyNode)
            : (nameOf(keyNode) ?? literalString(keyNode));
          if (key === undefined) {
            if (ref && ref.module !== "network" && ref.module !== "global")
              markUnresolved(property, `a computed key destructured from ${ref.module}`);
            bindPattern(asNode(property.value), undefined);
            continue;
          }
          changed = bindPattern(asNode(property.value), ref && extend(ref, key)) || changed;
        }
        return changed;
      }
      case "AssignmentPattern":
        return bindPattern(asNode(pattern.left), ref);
      case "ArrayPattern":
        for (const element of (pattern.elements as unknown[] | undefined) ?? [])
          bindPattern(asNode(element), undefined);
        return false;
      default:
        return false;
    }
  };

  // Imports bind once; declarations and assignments to a fixpoint (an alias may precede its
  // source in walk order).
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    const complete = walker(program, (node) => {
      if (node.type === "ImportDeclaration") {
        const id = moduleOfSpecifier(literalString(asNode(node.source)) ?? "");
        for (const raw of (node.specifiers as unknown[] | undefined) ?? []) {
          const specifier = asNode(raw);
          const local = asNode(specifier?.local);
          if (!specifier || !local) continue;
          if (specifier.type === "ImportSpecifier") {
            const imported = asNode(specifier.imported);
            const key = nameOf(imported) ?? literalString(imported) ?? "";
            if (key === "createRequire") requireNames.add(nameOf(local) ?? "");
            changed =
              bindPattern(local, id ? extend({ module: id, path: [] }, key) : undefined) || changed;
          } else changed = bindPattern(local, id ? { module: id, path: [] } : undefined) || changed;
        }
      } else if (node.type === "TSImportEqualsDeclaration") {
        const reference = asNode(node.moduleReference);
        const id = moduleOfSpecifier(literalString(asNode(reference?.expression)) ?? "");
        changed =
          bindPattern(asNode(node.id), id ? { module: id, path: [] } : undefined) || changed;
      } else if (node.type === "VariableDeclarator") {
        const init = asNode(node.init);
        const id = asNode(node.id);
        const callee = init?.type === "CallExpression" ? asNode(init.callee) : undefined;
        const calleeName =
          nameOf(callee) ?? (callee?.type === "MemberExpression" ? memberKey(callee) : undefined);
        if (calleeName === "createRequire" && nameOf(id)) {
          if (!requireNames.has(nameOf(id) ?? "")) changed = true;
          requireNames.add(nameOf(id) ?? "");
          if (id) declared.add(id);
        } else changed = bindPattern(id, init ? rawRef(init) : undefined) || changed;
      } else if (node.type === "AssignmentExpression" && node.operator === "=") {
        const right = asNode(node.right);
        const left = asNode(node.left);
        if (left?.type === "Identifier" || left?.type === "ObjectPattern")
          changed = bindPattern(left, right ? rawRef(right) : undefined) || changed;
      } else if (
        node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression" ||
        node.type === "CatchClause"
      ) {
        const params =
          node.type === "CatchClause" ? [node.param] : ((node.params as unknown[]) ?? []);
        for (const param of params) markDeclared(asNode(param), declared);
      }
    });
    if (!complete) truncated = true;
    if (!changed) break;
  }

  const complete = walker(program, (node, parent) => {
    if (node.type === "Identifier" && (declared.has(node) || !isReference(node, parent))) return;
    if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
      if (memberKey(node) === undefined) {
        const base = rawRef(asNode(node.object) ?? node);
        const isEnv =
          base?.module === "process" && base.path.length === 1 && base.path[0] === "env";
        if (base && !isEnv && (base.module === "global" || sensitive(base)))
          markUnresolved(node, `a computed key read off ${base.module}`);
      }
    }
    if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
      if (requiredModule(node) === null)
        markUnresolved(node, "a module loaded by a name that isn't a literal");
      if (isReflectGet(node)) {
        const args = (node.arguments as unknown[] | undefined) ?? [];
        const target = asNode(args[0]);
        const base = target ? rawRef(target) : undefined;
        if (
          (base?.module === "global" || sensitive(base)) &&
          literalString(asNode(args[1])) === undefined
        )
          markUnresolved(node, `a computed key read off ${base.module}`);
      }
    }
    if (node.type === "ImportExpression" && literalString(asNode(node.source)) === undefined)
      markUnresolved(node, "a module loaded by a name that isn't a literal");
    const ref = rawRef(node);
    if (!sensitive(ref) || !whole(ref)) return;
    if (parent && consumes(parent, node, rawRef)) return;
    markUnresolved(node, `the whole ${ref.module} module handed on`);
  });
  if (!complete) truncated = true;

  return {
    refOf: (node) => {
      const ref = rawRef(node);
      return ref && ref.module !== "global" ? (ref as ModuleRef) : undefined;
    },
    unresolved: [...unresolved.values()],
    truncated,
    isBound: (name) => names.has(name),
  };
}

function markDeclared(pattern: JsNode | undefined, declared: WeakSet<JsNode>): void {
  if (!pattern) return;
  if (pattern.type === "Identifier") declared.add(pattern);
  else if (pattern.type === "AssignmentPattern") markDeclared(asNode(pattern.left), declared);
  else if (pattern.type === "RestElement") markDeclared(asNode(pattern.argument), declared);
  else if (pattern.type === "ObjectPattern")
    for (const prop of (pattern.properties as unknown[] | undefined) ?? []) {
      const property = asNode(prop);
      markDeclared(asNode(property?.value) ?? asNode(property?.argument), declared);
    }
  else if (pattern.type === "ArrayPattern")
    for (const element of (pattern.elements as unknown[] | undefined) ?? [])
      markDeclared(asNode(element), declared);
}

/**
 * Whether `parent` takes `node`'s module reference without handing the whole module on: a member
 * read, `Reflect.get`, an alias or destructuring the bindings follow, `typeof`, or a wrapper that
 * passes it through (the wrapper is judged by its own parent).
 */
function consumes(parent: JsNode, node: JsNode, refOf: (node: JsNode) => Ref | undefined): boolean {
  switch (parent.type) {
    case "MemberExpression":
    case "OptionalMemberExpression":
      return parent.object === node;
    case "CallExpression":
    case "OptionalCallExpression":
      // `Reflect.get(mod, ...)`, or a `require(...)`'s own callee.
      return (
        (isReflectGet(parent) && (parent.arguments as unknown[] | undefined)?.[0] === node) ||
        parent.callee === node
      );
    case "VariableDeclarator":
      return parent.init === node;
    case "AssignmentExpression":
      return parent.right === node;
    case "UnaryExpression":
      return parent.operator === "typeof";
    case "BinaryExpression":
      // `typeof process !== "undefined"`, `"env" in process`.
      return parent.operator === "in" || /^[!=]==?$/.test(String(parent.operator));
    case "IfStatement":
    case "ConditionalExpression":
      return parent.test === node;
    case "ExpressionStatement":
      return true;
    default:
      return TRANSPARENT.has(parent.type) && refOf(parent) !== undefined;
  }
}
