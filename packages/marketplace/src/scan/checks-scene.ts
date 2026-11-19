import type { MarketScanFinding } from "@ace/protocol/marketplace";
import { isSceneFile } from "@ace/suits";
import type { ArchiveFile } from "../archive.ts";
import { text as decodeText } from "../listing.ts";
import { type JsNode, lineOf, nodeCap, parseJs, walk } from "./js-ast.ts";
import { normaliseText } from "./text.ts";

/*
 * The `scene` check (ADR 0174 §8): a Suit's scene JS draws, nothing more. This is the static gate;
 * the scene's sandboxed, opaque-origin iframe and its CSP (ADR 0150) stay as independent runtime
 * enforcement, so a scene this check misreads still can't reach the network or ace's page.
 *
 * A scene is read by the real parser and held to a capability allowlist, not a list of spellings:
 * every name that resolves to no binding in the scene is a global, and a global off `GLOBALS` is a
 * block. On top of that, reflective paths to a callable (`.constructor`, `.__proto__`,
 * `.prototype`), property names built at run time, computed reads off a global, string timers,
 * `import`, remote URLs and DOM escapes are blocks wherever they appear. A scene the parser can't
 * read whole is a block: a scene must be readable. The Suit's CSS and SVG/HTML ornaments are read
 * here too, for remote `url()`, `@import`, scripts and external references.
 */

type Level = MarketScanFinding["level"];

/** A global a scene may use, and, when listed, the only members it may read off it. */
const GLOBALS: ReadonlyMap<string, readonly string[] | undefined> = new Map<
  string,
  readonly string[] | undefined
>([
  // The scene contract: `ace.scene({...})` and `ace.finish()`; everything else arrives as params.
  ["ace", ["scene", "finish"]],
  ["Math", undefined],
  ["Date", undefined],
  ["performance", ["now"]],
  ["requestAnimationFrame", undefined],
  ["cancelAnimationFrame", undefined],
  ["setTimeout", undefined],
  ["setInterval", undefined],
  ["clearTimeout", undefined],
  ["clearInterval", undefined],
  ["console", undefined],
  // Drawing.
  ["document", ["createElement"]],
  ["OffscreenCanvas", undefined],
  ["Path2D", undefined],
  ["DOMMatrix", undefined],
  ["DOMPoint", undefined],
  ["ImageData", undefined],
  ["Image", undefined],
  ["createImageBitmap", undefined],
  // The language.
  ["undefined", undefined],
  ["NaN", undefined],
  ["Infinity", undefined],
  ["arguments", undefined],
  [
    "Object",
    ["keys", "values", "entries", "assign", "freeze", "isFrozen", "fromEntries", "create"],
  ],
  ["Array", undefined],
  ["Number", undefined],
  ["String", undefined],
  ["Boolean", undefined],
  ["Symbol", undefined],
  ["JSON", undefined],
  ["Map", undefined],
  ["Set", undefined],
  ["WeakMap", undefined],
  ["WeakSet", undefined],
  ["Promise", undefined],
  ["Error", undefined],
  ["TypeError", undefined],
  ["RangeError", undefined],
  ["parseInt", undefined],
  ["parseFloat", undefined],
  ["isFinite", undefined],
  ["isNaN", undefined],
  ["ArrayBuffer", undefined],
  ["DataView", undefined],
  ["Float32Array", undefined],
  ["Float64Array", undefined],
  ["Int8Array", undefined],
  ["Int16Array", undefined],
  ["Int32Array", undefined],
  ["Uint8Array", undefined],
  ["Uint8ClampedArray", undefined],
  ["Uint16Array", undefined],
  ["Uint32Array", undefined],
]);

/** Names that are the global object itself; only `G.allowed` reads through them. */
const GLOBAL_OBJECTS = new Set(["globalThis", "window", "self", "frames"]);

/** Off-list globals with their own rule, so a finding says what the scene reached for. */
const NAMED: ReadonlyMap<string, [rule: string, message: string]> = new Map([
  ["fetch", ["scene-fetch", "calls fetch"]],
  ["XMLHttpRequest", ["scene-xhr", "uses XMLHttpRequest"]],
  ["WebSocket", ["scene-websocket", "opens a WebSocket"]],
  ["EventSource", ["scene-eventsource", "opens an EventSource"]],
  ["RTCPeerConnection", ["scene-rtc", "opens an RTCPeerConnection"]],
  ["sendBeacon", ["scene-beacon", "calls sendBeacon"]],
  ["eval", ["scene-eval", "calls eval"]],
  ["Function", ["scene-function-constructor", "builds a function from a string"]],
  ["importScripts", ["scene-dynamic-import", "imports code with importScripts"]],
  ["Worker", ["scene-worker", "starts a Worker"]],
  ["SharedWorker", ["scene-worker", "starts a SharedWorker"]],
  ["ServiceWorker", ["scene-service-worker", "reaches a service worker"]],
  ["serviceWorker", ["scene-service-worker", "reaches a service worker"]],
  ["SharedArrayBuffer", ["scene-shared-memory", "uses shared memory"]],
  ["Atomics", ["scene-shared-memory", "uses shared memory"]],
  ["WebAssembly", ["scene-wasm", "uses WebAssembly"]],
  ["parent", ["scene-parent-frame", "reaches its parent frame"]],
  ["top", ["scene-parent-frame", "reaches its parent frame"]],
  ["opener", ["scene-parent-frame", "reaches its parent frame"]],
  ["postMessage", ["scene-parent-frame", "posts a message to another frame"]],
]);

/**
 * The names that reach another frame. Reading one as a member of anything is a block, since an
 * event's `view` or an alias can hold the global object; as a plain string it isn't. `top` is the
 * exception: it's a block off the global object or an unproven `this` (through `NAMED`), but a
 * scene's own data may name it (an outfit's `top` colour), and from `top` a scene still needs
 * `postMessage`, which is blocked everywhere, or a navigation the sandbox refuses.
 */
const FRAME_MEMBERS = new Set(["parent", "opener", "frames", "postMessage"]);

/**
 * Member names that are a block on any object: reflective paths to a callable, the global object,
 * the DOM around the canvas, and the network and code-running names under any alias.
 */
const DENIED_MEMBERS = new Set([
  "constructor",
  "__proto__",
  "prototype",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "caller",
  "callee",
  "globalThis",
  "ownerDocument",
  "defaultView",
  "contentWindow",
  "contentDocument",
  "innerHTML",
  "outerHTML",
  "insertAdjacentHTML",
  "srcdoc",
  "createElementNS",
  ...[...NAMED.keys()].filter((name) => name !== "top"),
  ...FRAME_MEMBERS,
]);

/** Calls whose result is a string built at run time. */
const STRING_BUILDERS = new Set([
  "join",
  "concat",
  "fromCharCode",
  "fromCodePoint",
  "atob",
  "replace",
  "replaceAll",
  "reverse",
  "toString",
  "slice",
  "substring",
  "substr",
  "toLowerCase",
  "toUpperCase",
  "repeat",
  "padStart",
  "padEnd",
  "trim",
  "charAt",
  "at",
  "normalize",
  "String",
  "decodeURIComponent",
  "decodeURI",
  "unescape",
]);

const REMOTE_URL = /(?:\b(?:https?|wss?|ftp):\/\/|^\s*\/\/[^/\s])/i;

/** The most findings one file reports; past this the file is blocked many times over. */
const findingCap = 40;

interface Binding {
  constant: boolean;
  init?: JsNode | undefined;
  /** Assigned a string built at run time somewhere, so its value can't be known. */
  built: boolean;
}

interface Scope {
  names: Map<string, Binding>;
  parent: Scope | undefined;
}

const FUNCTIONS = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ObjectMethod",
  "ClassMethod",
  "ClassPrivateMethod",
]);

const isNode = (value: unknown): value is JsNode =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { type?: unknown }).type === "string";

const child = (node: JsNode, key: string): JsNode | undefined => {
  const value = node[key];
  return isNode(value) ? value : undefined;
};

const children = (node: JsNode, key: string): JsNode[] => {
  const value = node[key];
  return Array.isArray(value) ? value.filter(isNode) : [];
};

const nameOf = (node: JsNode | undefined): string | undefined =>
  node?.type === "Identifier" && typeof node["name"] === "string" ? node["name"] : undefined;

/** The names a binding pattern declares. */
function patternNames(pattern: JsNode | undefined, out: string[]): string[] {
  if (!pattern) return out;
  const name = nameOf(pattern);
  if (name !== undefined) out.push(name);
  else if (pattern.type === "ObjectPattern")
    for (const property of children(pattern, "properties"))
      patternNames(
        property.type === "RestElement" ? child(property, "argument") : child(property, "value"),
        out,
      );
  else if (pattern.type === "ArrayPattern")
    for (const element of children(pattern, "elements")) patternNames(element, out);
  else if (pattern.type === "AssignmentPattern") patternNames(child(pattern, "left"), out);
  else if (pattern.type === "RestElement") patternNames(child(pattern, "argument"), out);
  return out;
}

/** The scene reader: one file, its scopes and its findings. */
class SceneReader {
  readonly findings: MarketScanFinding[] = [];
  private readonly seen = new Set<string>();
  private visited = 0;
  overflow = false;
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  report(rule: string, node: JsNode, message: string, level: Level = "block"): void {
    const line = lineOf(node);
    const key = `${rule}:${message}`;
    if (this.seen.has(key) || this.findings.length >= findingCap) return;
    this.seen.add(key);
    const where = line === undefined ? this.path : `${this.path} line ${line}`;
    this.findings.push({
      check: "scene",
      rule,
      level,
      path: this.path,
      ...(line === undefined ? {} : { line }),
      message: `${where} ${message}; a Suit scene only draws`,
    });
  }

  // Scopes.

  private declare(scope: Scope, names: readonly string[], constant: boolean, init?: JsNode): void {
    for (const name of names)
      if (!scope.names.has(name)) scope.names.set(name, { constant, init, built: false });
  }

  private resolve(scope: Scope, name: string): Binding | undefined {
    for (let at: Scope | undefined = scope; at; at = at.parent) {
      const binding = at.names.get(name);
      if (binding) return binding;
    }
    return undefined;
  }

  /** `var` and function declarations of a function body, not crossing nested functions. */
  private hoist(node: JsNode, scope: Scope): void {
    const stack = [node];
    while (stack.length > 0) {
      const item = stack.pop();
      if (!item) break;
      if (item.type === "VariableDeclaration" && item["kind"] === "var")
        for (const declarator of children(item, "declarations"))
          this.declare(scope, patternNames(child(declarator, "id"), []), false);
      if (item !== node && FUNCTIONS.has(item.type)) {
        if (item.type === "FunctionDeclaration")
          this.declare(scope, patternNames(child(item, "id"), []), false);
        continue;
      }
      for (const [key, value] of Object.entries(item)) {
        if (key === "loc" || key === "extra" || key.endsWith("Comments")) continue;
        if (Array.isArray(value)) for (const entry of value) if (isNode(entry)) stack.push(entry);
        if (isNode(value)) stack.push(value);
      }
    }
  }

  /** `let`, `const`, `class` and function declarations directly in a statement list. */
  private lexical(statements: readonly JsNode[], scope: Scope): void {
    for (const raw of statements) {
      const statement =
        (raw.type === "ExportNamedDeclaration" || raw.type === "ExportDefaultDeclaration") &&
        child(raw, "declaration")
          ? (child(raw, "declaration") as JsNode)
          : raw;
      if (statement.type === "VariableDeclaration" && statement["kind"] !== "var")
        for (const declarator of children(statement, "declarations"))
          this.declare(
            scope,
            patternNames(child(declarator, "id"), []),
            statement["kind"] === "const",
            nameOf(child(declarator, "id")) === undefined ? undefined : child(declarator, "init"),
          );
      if (statement.type === "ClassDeclaration" || statement.type === "FunctionDeclaration")
        this.declare(scope, patternNames(child(statement, "id"), []), false);
    }
  }

  // Values.

  /** The string a node always evaluates to, when that can be known. */
  fold(node: JsNode | undefined, scope: Scope, depth = 0): string | undefined {
    if (!node || depth > 20) return undefined;
    if (node.type === "StringLiteral" && typeof node["value"] === "string") return node["value"];
    if (node.type === "NumericLiteral" && typeof node["value"] === "number")
      return String(node["value"]);
    if (node.type === "TemplateLiteral") {
      const quasis = children(node, "quasis");
      const expressions = children(node, "expressions");
      let out = "";
      for (const [index, quasi] of quasis.entries()) {
        const value = quasi["value"] as { cooked?: string | null } | undefined;
        if (typeof value?.cooked !== "string") return undefined;
        out += value.cooked;
        if (index < expressions.length) {
          const part = this.fold(expressions[index], scope, depth + 1);
          if (part === undefined) return undefined;
          out += part;
        }
      }
      return out;
    }
    if (node.type === "BinaryExpression" && node["operator"] === "+") {
      const left = this.fold(child(node, "left"), scope, depth + 1);
      const right = this.fold(child(node, "right"), scope, depth + 1);
      return left === undefined || right === undefined ? undefined : left + right;
    }
    const name = nameOf(node);
    if (name !== undefined) {
      const binding = this.resolve(scope, name);
      if (binding?.constant && !binding.built) return this.fold(binding.init, scope, depth + 1);
    }
    return undefined;
  }

  /** A node that is, or may be, a string: a string literal, a template or a built string. */
  stringy(node: JsNode | undefined, scope: Scope, depth = 0): boolean {
    return (
      node?.type === "StringLiteral" ||
      node?.type === "TemplateLiteral" ||
      this.fold(node, scope, depth)?.match(/^-?[\d.e+]+$/) === null ||
      this.built(node, scope, depth)
    );
  }

  /** A node whose value is a string put together at run time (not a constant). */
  built(node: JsNode | undefined, scope: Scope, depth = 0): boolean {
    if (!node || depth > 20) return false;
    if (node.type === "TemplateLiteral") return children(node, "expressions").length > 0;
    if (node.type === "BinaryExpression" && node["operator"] === "+") {
      const left = child(node, "left");
      const right = child(node, "right");
      return this.stringy(left, scope, depth + 1) || this.stringy(right, scope, depth + 1);
    }
    if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
      const callee = child(node, "callee");
      const name =
        nameOf(callee) ??
        (callee?.type === "MemberExpression" || callee?.type === "OptionalMemberExpression"
          ? (nameOf(child(callee, "property")) ?? this.fold(child(callee, "property"), scope))
          : undefined);
      return name !== undefined && STRING_BUILDERS.has(name);
    }
    const name = nameOf(node);
    if (name !== undefined) {
      const binding = this.resolve(scope, name);
      if (binding?.built) return true;
      if (binding?.constant) return this.built(binding.init, scope, depth + 1);
    }
    return false;
  }

  /** The string literal checks: remote URLs and denied names however they're spelled. */
  private strings(node: JsNode, value: string | undefined): void {
    if (value === undefined) return;
    if (REMOTE_URL.test(value)) this.report("scene-remote-url", node, "names a remote URL");
    if ((DENIED_MEMBERS.has(value) && !FRAME_MEMBERS.has(value)) || GLOBAL_OBJECTS.has(value))
      this.report("scene-reflection", node, `names \`${value}\` as a string`);
  }

  // References.

  private global(name: string, node: JsNode, member?: string): void {
    const named = NAMED.get(name);
    if (named) return this.report(named[0], node, named[1]);
    if (GLOBAL_OBJECTS.has(name)) {
      if (member === undefined)
        return this.report("scene-global-object", node, `reaches the global object \`${name}\``);
      return this.global(member, node);
    }
    if (!GLOBALS.has(name))
      return this.report("scene-global", node, `uses \`${name}\`, which a scene can't use`);
    const members = GLOBALS.get(name);
    if (members === undefined) return;
    if (member === undefined)
      this.report("scene-global", node, `uses \`${name}\` other than through its allowed members`);
    else if (!members.includes(member))
      this.report("scene-global", node, `uses \`${name}.${member}\`, which a scene can't use`);
  }

  private reference(node: JsNode, scope: Scope): void {
    const name = nameOf(node);
    if (name !== undefined && !this.resolve(scope, name)) this.global(name, node);
  }

  // The walk.

  read(program: JsNode): void {
    const scope: Scope = { names: new Map(), parent: undefined };
    this.hoist(program, scope);
    const body = children(program, "body");
    this.lexical(body, scope);
    for (const statement of body) this.visit(statement, scope, false, 0);
  }

  private visitAll(nodes: readonly JsNode[], scope: Scope, thisBound: boolean, depth: number) {
    for (const node of nodes) this.visit(node, scope, thisBound, depth);
  }

  /** Visits every child field of a node with no special meaning. */
  private visitChildren(node: JsNode, scope: Scope, thisBound: boolean, depth: number): void {
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc" || key === "extra" || key.endsWith("Comments")) continue;
      if (Array.isArray(value))
        for (const entry of value) {
          if (isNode(entry)) this.visit(entry, scope, thisBound, depth);
        }
      else if (isNode(value)) this.visit(value, scope, thisBound, depth);
    }
  }

  /** A binding pattern's default values and computed keys; its names are declared elsewhere. */
  private visitPattern(
    pattern: JsNode | undefined,
    scope: Scope,
    thisBound: boolean,
    depth: number,
  ) {
    if (!pattern) return;
    if (pattern.type === "ObjectPattern")
      for (const property of children(pattern, "properties")) {
        if (property.type === "RestElement") {
          this.visitPattern(child(property, "argument"), scope, thisBound, depth);
          continue;
        }
        const key = child(property, "key");
        if (property["computed"] === true) this.visit(key, scope, thisBound, depth);
        const keyName = property["computed"] === true ? this.fold(key, scope) : nameOf(key);
        if (keyName !== undefined && DENIED_MEMBERS.has(keyName) && key)
          this.report("scene-reflection", key, `reads \`${keyName}\``);
        this.visitPattern(child(property, "value"), scope, thisBound, depth);
      }
    else if (pattern.type === "ArrayPattern")
      for (const element of children(pattern, "elements"))
        this.visitPattern(element, scope, thisBound, depth);
    else if (pattern.type === "AssignmentPattern") {
      this.visitPattern(child(pattern, "left"), scope, thisBound, depth);
      this.visit(child(pattern, "right"), scope, thisBound, depth);
    } else if (pattern.type === "RestElement")
      this.visitPattern(child(pattern, "argument"), scope, thisBound, depth);
    else if (pattern.type !== "Identifier") this.visit(pattern, scope, thisBound, depth);
  }

  /** An assignment target: names in it are references, not declarations. */
  private visitTarget(target: JsNode | undefined, scope: Scope, thisBound: boolean, depth: number) {
    if (!target) return;
    if (target.type === "Identifier") return this.reference(target, scope);
    this.visitPattern(target, scope, thisBound, depth);
    for (const name of patternNames(target, [])) {
      if (!this.resolve(scope, name)) this.global(name, target);
    }
  }

  private visitFunction(node: JsNode, outer: Scope, outerThis: boolean, depth: number): void {
    if (node["computed"] === true) this.visit(child(node, "key"), outer, outerThis, depth);
    const scope: Scope = { names: new Map(), parent: outer };
    if (node.type === "FunctionExpression")
      this.declare(scope, patternNames(child(node, "id"), []), false);
    const params = children(node, "params");
    for (const param of params) this.declare(scope, patternNames(param, []), false);
    // `this` is proven only where the language fixes it: an arrow keeps its outer `this`, and a
    // class constructor's is the new instance (a class can't be called without `new`). Any other
    // function can be handed to a timer or a listener, which runs it with `this` as the global
    // object or an element, so its `this` is read as the global object (fail closed).
    const thisBound =
      node.type === "ArrowFunctionExpression"
        ? outerThis
        : node.type === "ClassMethod" && node["kind"] === "constructor";
    for (const param of params) this.visitPattern(param, scope, thisBound, depth);
    const body = child(node, "body");
    if (body?.type === "BlockStatement") {
      this.hoist(body, scope);
      const statements = children(body, "body");
      this.lexical(statements, scope);
      this.visitAll(statements, scope, thisBound, depth);
    } else this.visit(body, scope, thisBound, depth);
  }

  private visitMember(node: JsNode, scope: Scope, thisBound: boolean, depth: number): void {
    const object = child(node, "object");
    const property = child(node, "property");
    const computed = node["computed"] === true;
    const member = computed ? this.fold(property, scope) : nameOf(property);
    if (member !== undefined && DENIED_MEMBERS.has(member))
      this.report("scene-reflection", node, `reads \`.${member}\``);
    const objectName = nameOf(object);
    const objectGlobal = objectName !== undefined && !this.resolve(scope, objectName);
    if (computed && member === undefined) {
      if (this.built(property, scope))
        this.report("scene-built-name", node, "reads a property whose name is built at run time");
      if (objectGlobal)
        this.report("scene-computed-global", node, `reads \`${objectName}[…]\` by a computed name`);
      if (object?.type === "ThisExpression")
        this.report("scene-computed-global", node, "reads `this[…]` by a computed name");
    }
    if (object?.type === "ThisExpression" && !thisBound) {
      // An unproven `this` is the global object: `this.x` is held to the allowlist as
      // `globalThis.x` is.
      if (member !== undefined) this.global(member, node);
    } else if (objectGlobal && objectName !== undefined) {
      if (member !== undefined || !computed) this.global(objectName, node, member);
      else if (!GLOBALS.has(objectName)) this.global(objectName, node);
    } else this.visit(object, scope, thisBound, depth);
    if (computed) this.visit(property, scope, thisBound, depth);
  }

  private visitCall(node: JsNode, scope: Scope, thisBound: boolean, depth: number): void {
    const callee = child(node, "callee");
    const args = children(node, "arguments");
    const calleeName = nameOf(callee);
    const global = calleeName !== undefined && !this.resolve(scope, calleeName);
    if (callee?.type === "Import")
      this.report("scene-dynamic-import", node, "imports code dynamically");
    // A method picked by a name computed at run time is how `x[k()]("code")` reaches a
    // constructor; a scene calls what it names. (Aliasing it first gets past this; the CSP's
    // missing 'unsafe-eval' still refuses to run the string.)
    if (
      (callee?.type === "MemberExpression" || callee?.type === "OptionalMemberExpression") &&
      callee["computed"] === true &&
      this.fold(child(callee, "property"), scope) === undefined
    )
      this.report("scene-computed-call", node, "calls a method chosen by a computed name");
    if (global && (calleeName === "setTimeout" || calleeName === "setInterval")) {
      const first = args[0];
      const callable =
        first === undefined ||
        first.type === "FunctionExpression" ||
        first.type === "ArrowFunctionExpression" ||
        ((first.type === "Identifier" || first.type === "MemberExpression") &&
          this.fold(first, scope) === undefined &&
          !this.built(first, scope));
      if (!callable) this.report("scene-string-timer", node, "runs a string on a timer");
    }
    if (
      callee?.type === "MemberExpression" &&
      nameOf(child(callee, "object")) === "document" &&
      !this.resolve(scope, "document")
    ) {
      const tag = this.fold(args[0], scope)?.toLowerCase();
      if (tag !== "canvas")
        this.report("scene-dom", node, "creates a DOM element other than a canvas");
    }
    this.visitChildren(node, scope, thisBound, depth);
  }

  visit(node: JsNode | undefined, scope: Scope, thisBound: boolean, depth: number): void {
    if (!node) return;
    if (++this.visited > nodeCap || depth > 1000) {
      this.overflow = true;
      return;
    }
    const next = depth + 1;
    switch (node.type) {
      case "Identifier":
        return this.reference(node, scope);
      case "StringLiteral":
        return this.strings(node, this.fold(node, scope));
      case "TemplateLiteral":
        this.strings(node, this.fold(node, scope));
        for (const quasi of children(node, "quasis")) {
          const value = quasi["value"] as { cooked?: string | null } | undefined;
          this.strings(node, value?.cooked ?? undefined);
        }
        return this.visitAll(children(node, "expressions"), scope, thisBound, next);
      case "BinaryExpression":
        if (node["operator"] === "+") this.strings(node, this.fold(node, scope));
        return this.visitChildren(node, scope, thisBound, next);
      case "ThisExpression":
        if (!thisBound)
          this.report(
            "scene-global-object",
            node,
            "reads `this` where it may be the global object",
          );
        return;
      case "MemberExpression":
      case "OptionalMemberExpression":
        return this.visitMember(node, scope, thisBound, next);
      case "CallExpression":
      case "OptionalCallExpression":
      case "NewExpression":
        return this.visitCall(node, scope, thisBound, next);
      case "ImportExpression":
        this.report("scene-dynamic-import", node, "imports code dynamically");
        return this.visitChildren(node, scope, thisBound, next);
      case "ImportDeclaration":
      case "ExportAllDeclaration":
        return this.report("scene-dynamic-import", node, "imports another module");
      case "ExportNamedDeclaration":
        if (child(node, "source"))
          return this.report("scene-dynamic-import", node, "imports another module");
        for (const specifier of children(node, "specifiers"))
          this.reference(child(specifier, "local") ?? specifier, scope);
        return this.visit(child(node, "declaration"), scope, thisBound, next);
      case "WithStatement":
        this.report("scene-global-object", node, "uses `with`");
        return this.visitChildren(node, scope, thisBound, next);
      case "MetaProperty":
      case "BreakStatement":
      case "ContinueStatement":
      case "PrivateName":
        return;
      case "LabeledStatement":
        return this.visit(child(node, "body"), scope, thisBound, next);
      case "VariableDeclaration":
        for (const declarator of children(node, "declarations")) {
          const id = child(declarator, "id");
          const init = child(declarator, "init");
          const name = nameOf(id);
          const binding = name === undefined ? undefined : this.resolve(scope, name);
          // A literal string is checked where it's written; one built at run time taints the name.
          if (binding) {
            if (binding.constant) binding.init = init;
            else if (this.built(init, scope)) binding.built = true;
          }
          this.visitPattern(id, scope, thisBound, next);
          this.visit(init, scope, thisBound, next);
        }
        return;
      case "AssignmentExpression": {
        const left = child(node, "left");
        const right = child(node, "right");
        const name = nameOf(left);
        const binding = name === undefined ? undefined : this.resolve(scope, name);
        if (
          binding &&
          (node["operator"] === "+=" ? this.stringy(right, scope) : this.built(right, scope))
        )
          binding.built = true;
        this.visitTarget(left, scope, thisBound, next);
        return this.visit(right, scope, thisBound, next);
      }
      case "UpdateExpression":
        return this.visitTarget(child(node, "argument"), scope, thisBound, next);
      case "ForInStatement":
      case "ForOfStatement":
      case "ForStatement": {
        const inner: Scope = { names: new Map(), parent: scope };
        const head = child(node, node.type === "ForStatement" ? "init" : "left");
        if (head?.type === "VariableDeclaration" && head["kind"] !== "var")
          for (const declarator of children(head, "declarations"))
            this.declare(inner, patternNames(child(declarator, "id"), []), false);
        if (head && head.type !== "VariableDeclaration" && node.type !== "ForStatement")
          this.visitTarget(head, inner, thisBound, next);
        else this.visit(head, inner, thisBound, next);
        for (const key of ["test", "update", "right", "body"])
          this.visit(child(node, key), inner, thisBound, next);
        return;
      }
      case "BlockStatement":
      case "StaticBlock": {
        const inner: Scope = { names: new Map(), parent: scope };
        const statements = children(node, "body");
        this.lexical(statements, inner);
        return this.visitAll(statements, inner, node.type === "StaticBlock" || thisBound, next);
      }
      case "SwitchStatement": {
        this.visit(child(node, "discriminant"), scope, thisBound, next);
        const inner: Scope = { names: new Map(), parent: scope };
        const cases = children(node, "cases");
        for (const entry of cases) this.lexical(children(entry, "consequent"), inner);
        return this.visitAll(cases, inner, thisBound, next);
      }
      case "CatchClause": {
        const inner: Scope = { names: new Map(), parent: scope };
        const param = child(node, "param");
        this.declare(inner, patternNames(param, []), false);
        this.visitPattern(param, inner, thisBound, next);
        return this.visit(child(node, "body"), inner, thisBound, next);
      }
      case "ClassDeclaration":
      case "ClassExpression": {
        const inner: Scope = { names: new Map(), parent: scope };
        if (node.type === "ClassExpression")
          this.declare(inner, patternNames(child(node, "id"), []), false);
        this.visit(child(node, "superClass"), scope, thisBound, next);
        for (const member of children(child(node, "body") ?? node, "body")) {
          if (FUNCTIONS.has(member.type)) this.visitFunction(member, inner, true, next);
          else {
            if (member["computed"] === true) this.visit(child(member, "key"), inner, true, next);
            this.visit(child(member, "value"), inner, true, next);
            if (member.type === "StaticBlock") this.visit(member, inner, true, next);
          }
        }
        return;
      }
      case "ObjectExpression":
        for (const property of children(node, "properties")) {
          if (property.type === "ObjectMethod")
            this.visitFunction(property, scope, thisBound, next);
          else if (property.type === "ObjectProperty") {
            const key = child(property, "key");
            if (property["computed"] === true) this.visit(key, scope, thisBound, next);
            else if (key && nameOf(key) === "__proto__")
              this.report("scene-reflection", key, "sets `__proto__`");
            this.visit(child(property, "value"), scope, thisBound, next);
          } else this.visit(property, scope, thisBound, next);
        }
        return;
      default:
        if (FUNCTIONS.has(node.type)) return this.visitFunction(node, scope, thisBound, next);
        return this.visitChildren(node, scope, thisBound, next);
    }
  }
}

const isTrue = (node: JsNode | undefined): boolean =>
  (node?.type === "BooleanLiteral" && node["value"] === true) ||
  (node?.type === "NumericLiteral" && node["value"] !== 0);

/** `while (true)`, `for (;;)` and `do … while (true)` with no way out and no yield in them. */
function unboundedLoops(program: JsNode): JsNode[] {
  const loops: JsNode[] = [];
  walk(program, (node) => {
    const forever =
      ((node.type === "WhileStatement" || node.type === "DoWhileStatement") &&
        isTrue(child(node, "test"))) ||
      (node.type === "ForStatement" && (!child(node, "test") || isTrue(child(node, "test"))));
    if (!forever) return;
    const body = child(node, "body");
    let exits = false;
    if (body)
      walk(body, (inner) => {
        if (
          /^(?:BreakStatement|ReturnStatement|ThrowStatement|AwaitExpression|YieldExpression)$/.test(
            inner.type,
          )
        )
          exits = true;
      });
    if (!exits) loops.push(node);
  });
  return loops;
}

function sceneFindings(path: string, source: string): MarketScanFinding[] {
  const parsed = parseJs(source, { typescript: false });
  if (!parsed || parsed.recovered)
    return [
      {
        check: "scene",
        rule: "scene-unreadable",
        level: "block",
        path,
        message: `${path} can't be read as JavaScript; a Suit scene must be readable to be listed`,
      },
    ];
  const reader = new SceneReader(path);
  reader.read(parsed.program);
  if (reader.overflow)
    reader.report(
      "scene-unreadable",
      parsed.program,
      "is too large or too deeply nested to read whole",
    );
  for (const loop of unboundedLoops(parsed.program))
    reader.report(
      "scene-unbounded-loop",
      loop,
      "loops without yielding, which freezes the page",
      "warn",
    );
  return reader.findings;
}

// The Suit's CSS and markup.

/** CSS with comments blanked (newlines kept) and escapes undone, so `\68ttps:` reads as `https:`. */
const cssText = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?(?:\*\/|$)/g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/\\([0-9a-f]{1,6})[ \t]?/gi, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/\\([^\n0-9a-f])/gi, "$1");

const markupText = (text: string): string =>
  text
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);?/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&colon;/gi, ":")
    .replace(/&sol;/gi, "/");

const CSS_PATTERNS: readonly [rule: string, pattern: RegExp, message: string][] = [
  ["suit-css-import", /@import\b/i, "imports another stylesheet"],
  [
    "suit-css-remote-url",
    /url\(\s*["']?\s*(?:(?:[a-z][a-z0-9+.-]*:)?\/\/|(?:https?|wss?|ftp):)|["']\s*(?:(?:https?|wss?|ftp):|\/\/[^/\s])/i,
    "loads from a remote URL",
  ],
];

const MARKUP_PATTERNS: readonly [rule: string, pattern: RegExp, message: string][] = [
  ["suit-markup-script", /<\s*script\b|\son[a-z]+\s*=|javascript:/i, "runs a script"],
  [
    "suit-markup-external",
    /\b(?:href|src|xlink:href|action|data)\s*=\s*["']?\s*(?:(?:[a-z][a-z0-9+.-]*:)?\/\/|(?:https?|wss?|ftp):)|<\s*(?:iframe|object|embed|foreignObject)\b|<!ENTITY/i,
    "references something outside the Suit",
  ],
  ...CSS_PATTERNS,
];

function textFindings(
  path: string,
  text: string,
  patterns: readonly [string, RegExp, string][],
): MarketScanFinding[] {
  const lines = text.split("\n");
  const findings: MarketScanFinding[] = [];
  for (const [rule, pattern, message] of patterns) {
    const index = lines.findIndex((line) => pattern.test(line));
    if (index >= 0)
      findings.push({
        check: "scene",
        rule,
        level: "block",
        path,
        line: index + 1,
        message: `${path} line ${index + 1} ${message}; a Suit's files stay inside the Suit`,
      });
  }
  return findings;
}

/** The `scene` check over a Suit's files: its scenes, its CSS and its SVG or HTML ornaments. */
export function sceneCheck(files: readonly ArchiveFile[]): MarketScanFinding[] {
  const findings: MarketScanFinding[] = [];
  for (const file of files) {
    const isCss = /\.css$/i.test(file.path);
    const isMarkup = /\.(?:svg|html?)$/i.test(file.path);
    if (!isSceneFile(file.path) && !isCss && !isMarkup) continue;
    const source = decodeText(file.content);
    if (source === undefined) continue;
    const text = normaliseText(source);
    if (isSceneFile(file.path)) findings.push(...sceneFindings(file.path, text));
    else if (isCss) findings.push(...textFindings(file.path, cssText(text), CSS_PATTERNS));
    else findings.push(...textFindings(file.path, cssText(markupText(text)), MARKUP_PATTERNS));
  }
  return findings;
}
