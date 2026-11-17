import { lineOf, parseJs, walk, type JsNode } from "./js-ast.ts";
import {
  bindModules,
  isReference,
  literalString,
  patternNames,
  type ModuleBindings,
  type ModuleRef,
} from "./module-identity.ts";

const NET_METHOD =
  /^(?:fetch|request|get|post|put|send|sendBeacon|lookup|resolve|resolve4|resolve6|openSync|connect)$/;

import { HELD_LEVEL, TRUNCATED_LEVEL } from "./fail-closed.ts";
import type { ScriptView } from "./script-view.ts";

/*
 * Following sensitive data to the network (ADR 0173 §8). A real entry that logs in with a single
 * named key (`process.env.API_KEY` in a header) is ordinary; what no entry should do is send the
 * whole environment, a credential file, the home folder or a keychain out. So the rule reads the
 * severity of what reaches a network sink:
 *   - the whole environment, a credential file, the home folder or a keychain reaching a sink is a
 *     block;
 *   - a single named secret reaching a sink, or a sensitive source and a sink present in one file
 *     but not connected, is a warn (held for a maintainer), never a pass.
 * The rule fails closed: it doesn't list the sources that are dangerous, it lists the few it can
 * prove harmless. In a file that reaches the network or runs a program, every other read (an
 * environment on any runtime, a file at a path it can't resolve to a local constant, a reflective
 * or computed read, a value from a package it doesn't track) is treated as sensitive and held.
 * Pure: a parser for JavaScript and TypeScript, line patterns for Python and shell.
 */

export type FlowLevel = "block" | "warn";
export interface FlowHit {
  line?: number;
  level: FlowLevel;
  message: string;
  /** A cap dropped code the rule never read: reported as `scan-truncated`, not as a flow. */
  truncated?: true;
}

/* ---------------------------------------------------------------- JavaScript and TypeScript */

/** Paths that name a credential file or the home folder, as a string a read is given. */
const credentialPath =
  /(?:^|[\s"'`/~])\.(?:ssh|aws|config\/(?:gcloud|gsutil)|azure|kube|docker|npmrc|netrc|pgpass|git-credentials|env(?:\.[a-z]+)?)\b|(?:^|[\s"'`/~])(?:id_(?:rsa|ed25519|ecdsa|dsa)|credentials|\.pem|keychain)\b|Library\/Keychains\b/i;
/** Reads that hand back the whole environment. */
const WHOLE_ENV = /\bprocess\.env\b/;

/** A node's identifier name, when it has one. */
const idName = (node: JsNode): string | undefined =>
  node.type === "Identifier" && typeof node.name === "string" ? node.name : undefined;

const stringValue = (node: JsNode): string | undefined => {
  if (node.type === "StringLiteral" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && Array.isArray(node.quasis))
    return (node.quasis as JsNode[])
      .map((q) => {
        const cooked = (q.value as { cooked?: unknown } | undefined)?.cooked;
        return typeof cooked === "string" ? cooked : "";
      })
      .join(" ");
  return undefined;
};

/**
 * How sensitive a read is: the whole environment, a credential file, home or a keychain (severe);
 * one named secret (mild); or a value the scanner can't prove harmless (unproven), held all the same.
 */
type Severity = "severe" | "mild" | "unproven";
const RANK: Record<Severity, number> = { unproven: 1, mild: 2, severe: 3 };
const worse = (a: Severity | undefined, b: Severity | undefined): Severity | undefined =>
  !a ? b : !b ? a : RANK[a] >= RANK[b] ? a : b;
function sourceSeverity(node: JsNode, source: string): Severity | undefined {
  // os.homedir(), os.userInfo() on any object, and a credential-path file read on any object.
  if (node.type === "CallExpression") {
    const callee = node.callee as JsNode;
    if (callee.type === "MemberExpression") {
      const name = idName(callee.property as JsNode);
      if (name === "homedir" || name === "userInfo") return "severe";
      // A file read whose path names a credential file or home.
      if (name && /^read(?:File|FileSync|file)$/.test(name)) {
        const arg = (node.arguments as JsNode[] | undefined)?.[0];
        const path = arg ? stringValue(arg) : undefined;
        if (path && credentialPath.test(path)) return "severe";
      }
    }
  }
  // A read of the whole environment spread or serialised: Object.*(process.env), {...process.env},
  // JSON.stringify(process.env). These appear in `source` text around this node.
  if (
    WHOLE_ENV.test(source) &&
    /\{\s*\.\.\.\s*process\.env|Object\.(?:keys|values|entries|assign|fromEntries)\s*\(\s*process\.env|JSON\.stringify\s*\(\s*process\.env\s*\)|process\.env\s*\)/.test(
      source,
    )
  )
    return "severe";
  return undefined;
}

/** Every string a subtree always holds, for a credential path or a program name. */
function stringsIn(nodes: readonly JsNode[]): string[] {
  const strings: string[] = [];
  for (const root of nodes)
    walk(root, (child) => {
      const text = literalString(child) ?? stringValue(child);
      if (text !== undefined && strings.length < 64) strings.push(text);
    });
  return strings;
}

const argsOf = (node: JsNode): JsNode[] => (node.arguments as JsNode[] | undefined) ?? [];
const FS_READ = /^(?:read|createReadStream|open|copyFile|cp)/;
const EXEC =
  /^(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork|command|commandSync|\$)$/;
const SECRET_COMMAND =
  /(?:^|[\s;|&(])(?:env|printenv|set)(?:$|[\s;|&)])|\bsecurity\s+(?:find|dump)-/;
const NET_TOOL = /\b(?:curl|wget|nc|ncat|netcat|socat)\b/;

/** The callee of a call as a module reference, when it is a tracked module's member. */
const calleeRef = (node: JsNode, modules: ModuleBindings): ModuleRef | undefined => {
  if (node.type !== "CallExpression" && node.type !== "NewExpression") return undefined;
  return modules.refOf(node.callee as JsNode);
};

/** Whether a call runs a program through a bound child_process (or execa) module. */
const isExecCall = (node: JsNode, modules: ModuleBindings): boolean => {
  const ref = calleeRef(node, modules);
  if (ref?.module !== "child_process") return false;
  const last = ref.path.at(-1);
  return last === undefined || EXEC.test(last);
};

/**
 * Whether `parent` narrows `node`'s module reference further (`process.env` → `process.env.X`,
 * `Reflect.get(process.env, "X")`), so the parent is the read to judge, not the node.
 */
const narrowedBy = (node: JsNode, parent: JsNode | undefined): boolean => {
  if (!parent) return false;
  if (parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression")
    return parent.object === node;
  if (parent.type === "CallExpression") {
    const callee = parent.callee as JsNode;
    return (
      callee.type === "MemberExpression" &&
      idName(callee.object as JsNode) === "Reflect" &&
      idName(callee.property as JsNode) === "get" &&
      argsOf(parent)[0] === node
    );
  }
  return false;
};

/**
 * The severity of what a node reads through a tracked module: the whole environment, the home
 * folder, a keychain, a credential file read or a secret-printing command (severe), or one named
 * environment value (mild).
 */
function moduleSeverity(
  node: JsNode,
  parent: JsNode | undefined,
  modules: ModuleBindings,
): Severity | undefined {
  if (node.type === "Identifier" && !isReference(node, parent)) return undefined;
  if (node.type === "CallExpression") {
    const callee = calleeRef(node, modules);
    const last = callee?.path.at(-1);
    if (callee?.module === "fs" && last && FS_READ.test(last)) return pathSeverity(argsOf(node));
    if (isExecCall(node, modules)) {
      if (
        stringsIn(argsOf(node)).some(
          (text) => credentialPath.test(text) || SECRET_COMMAND.test(text),
        )
      )
        return "severe";
      // A program named by a value the scanner can't read: its output is unproven.
      const command = argsOf(node)[0];
      return command && literalString(command) === undefined ? "unproven" : undefined;
    }
  }
  const ref = modules.refOf(node);
  if (!ref || narrowedBy(node, parent)) return undefined;
  const [first] = ref.path;
  switch (ref.module) {
    case "process":
      if (first !== "env") return undefined;
      return ref.path.length === 1 ? "severe" : "mild";
    case "os":
      if (first === undefined || SAFE_OS.has(first)) return undefined;
      return first === "homedir" || first === "userInfo" ? "severe" : "unproven";
    case "keychain":
      return first !== undefined && /^(?:get|find)/i.test(first) ? "severe" : undefined;
    default:
      return undefined;
  }
}

/** `os` members that describe the platform, never the person: their values are local. */
const SAFE_OS = new Set([
  "platform",
  "arch",
  "type",
  "EOL",
  "endianness",
  "tmpdir",
  "devNull",
  "constants",
  "availableParallelism",
]);

/** A string path the scanner can prove local and harmless: relative, inside the entry, no secret. */
const safeLiteralPath = (text: string): boolean =>
  !credentialPath.test(text) &&
  !/^(?:[/~\\$]|[A-Za-z]:|file:)/.test(text) &&
  !/(?:^|[/\\])\.\.(?:[/\\]|$)/.test(text) &&
  !/\$\{?[A-Za-z_]/.test(text);

/** Whether a path argument resolves to a safe constant: a literal, or a join of literals and `.`. */
function safePathArg(node: JsNode | undefined): boolean {
  if (!node) return false;
  const text = literalString(node);
  if (text !== undefined) return safeLiteralPath(text);
  if (node.type === "Identifier") return node.name === "__dirname";
  if (node.type === "MemberExpression")
    return (node.object as JsNode).type === "MetaProperty" && staticKey(node) === "dirname";
  if (node.type === "CallExpression" || node.type === "NewExpression") {
    const callee = node.callee as JsNode;
    const name = idName(callee) ?? (callee.type === "MemberExpression" ? staticKey(callee) : "");
    const args = argsOf(node);
    if (name === "URL" && node.type === "NewExpression") return safePathArg(args[0]);
    if (name === "join" || name === "resolve")
      return args.length > 0 && args.every((arg, index) => safePathArg(arg) || isCwd(arg, index));
  }
  return false;
}
const isCwd = (node: JsNode, index: number): boolean => {
  if (index !== 0 || node.type !== "CallExpression") return false;
  const callee = node.callee as JsNode;
  return callee.type === "MemberExpression" && staticKey(callee) === "cwd";
};

/** A file read's severity by its path: a credential path, a provably local one, or unproven. */
function pathSeverity(args: readonly JsNode[]): Severity | undefined {
  if (stringsIn(args).some((text) => credentialPath.test(text))) return "severe";
  return safePathArg(args[0]) ? undefined : "unproven";
}

/** The key a member expression reads, when it is static (`a.b`, `a["b"]`). */
function staticKey(node: JsNode): string | undefined {
  const property = node.property as JsNode;
  if (!node.computed) return idName(property) ?? literalString(property);
  return literalString(property);
}
const isMember = (node: JsNode | undefined): node is JsNode =>
  node?.type === "MemberExpression" || node?.type === "OptionalMemberExpression";

/** What the flow rule knows about the file's names: tracked modules and its own declarations. */
export interface FlowScope {
  modules: ModuleBindings;
  /** Every name the file declares; a member chain rooted elsewhere is a runtime global. */
  declared: ReadonlySet<string>;
}

/** Every name a program declares (variables, parameters, functions, classes, imports). */
function declaredNames(program: JsNode, walker: typeof walk): Set<string> {
  const names = new Set<string>();
  walker(program, (node) => {
    switch (node.type) {
      case "VariableDeclarator":
        patternNames(node.id as JsNode, names);
        break;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
      case "ClassDeclaration":
        if (node.id) patternNames(node.id as JsNode, names);
        for (const param of (node.params as JsNode[] | undefined) ?? []) patternNames(param, names);
        break;
      case "CatchClause":
        if (node.param) patternNames(node.param as JsNode, names);
        break;
      case "ImportSpecifier":
      case "ImportDefaultSpecifier":
      case "ImportNamespaceSpecifier":
        patternNames(node.local as JsNode, names);
        break;
      default:
        break;
    }
  });
  return names;
}

/** Roots a member chain may start from that are a page, not the runtime. */
const PAGE_ROOTS = new Set(["window", "document", "self", "location", "navigator"]);

/**
 * Whether a member chain starts at a runtime global the file never declares (`Deno`, `Bun`,
 * `globalThis`, `import.meta`): the scanner can't prove what such a chain reads.
 */
function runtimeRooted(node: JsNode, scope: FlowScope): boolean {
  let root = node;
  for (let depth = 0; depth < 16 && isMember(root); depth++) root = root.object as JsNode;
  if (root.type === "MetaProperty") return true;
  const name = idName(root);
  return (
    name !== undefined &&
    name !== "process" &&
    !PAGE_ROOTS.has(name) &&
    !scope.declared.has(name) &&
    !scope.modules.isBound(name)
  );
}

/** `X.env` or `X.environ` on a runtime global the module bindings don't already resolve. */
const isRuntimeEnv = (node: JsNode | undefined, scope: FlowScope): boolean =>
  isMember(node) &&
  /^(?:env|environ)$/.test(staticKey(node) ?? "") &&
  scope.modules.refOf(node) === undefined &&
  runtimeRooted(node, scope);

const WHOLE_ENV_METHOD = /^(?:toObject|entries|keys|values|forEach)$/;
const RUNTIME_READ = /^(?:read\w*|file|open|openSync|cat)$/;
const RUNTIME_RUN = /^(?:spawn|spawnSync|Command|run|exec|\$)$/;
const RUNTIME_NET = /^(?:fetch|connect|connectTls|udpSocket|listenDatagram|startTls)$/;

/** A runtime global's member a call reaches (`Deno.readTextFile`, `Bun.spawn`). */
const runtimeMethod = (node: JsNode, scope: FlowScope): string | undefined => {
  if (node.type !== "CallExpression" && node.type !== "NewExpression") return undefined;
  const callee = node.callee as JsNode;
  return isMember(callee) && runtimeRooted(callee, scope) ? staticKey(callee) : undefined;
};

/**
 * The severity of a read through a runtime global (ADR 0173 §8, fails closed): its whole
 * environment is severe, one named value mild, a computed one or a file read at a path the
 * scanner can't resolve unproven.
 */
function runtimeSeverity(
  node: JsNode,
  parent: JsNode | undefined,
  scope: FlowScope,
): Severity | undefined {
  if (isRuntimeEnv(node, scope)) return narrowedBy(node, parent) ? undefined : "severe";
  if (isMember(node) && isRuntimeEnv(node.object as JsNode, scope)) {
    const key = staticKey(node);
    if (key === undefined) return "unproven";
    return WHOLE_ENV_METHOD.test(key) ? "severe" : "mild";
  }
  const method = runtimeMethod(node, scope);
  if (method && RUNTIME_READ.test(method)) return pathSeverity(argsOf(node));
  return undefined;
}

/** Whether a call runs a program through a runtime global or an untracked `$` tag. */
function runtimeRuns(node: JsNode, scope: FlowScope): boolean {
  if (node.type === "TaggedTemplateExpression") {
    const tag = node.tag as JsNode;
    if (isMember(tag)) return runtimeRooted(tag, scope) && staticKey(tag) === "$";
    return idName(tag) === "$" && scope.modules.isForeign("$");
  }
  const method = runtimeMethod(node, scope);
  return method !== undefined && RUNTIME_RUN.test(method);
}

/** The values a sink is handed: a call's arguments, or a tagged template's expressions. */
const sinkArgs = (node: JsNode): JsNode[] =>
  node.type === "TaggedTemplateExpression"
    ? ((((node.quasi as JsNode).expressions as JsNode[] | undefined) ?? []) as JsNode[])
    : argsOf(node);

/** Whether a call is a network sink: a known client, a bound network module, a network tool run. */
function sinkOf(node: JsNode, modules: ModuleBindings, scope?: FlowScope): boolean {
  if (scope && node.type === "TaggedTemplateExpression")
    return (
      runtimeRuns(node, scope) &&
      stringsIn([node.quasi as JsNode]).some((text) => NET_TOOL.test(text))
    );
  if (node.type !== "CallExpression" && node.type !== "NewExpression") return false;
  if (scope) {
    const method = runtimeMethod(node, scope);
    if (method && RUNTIME_NET.test(method)) return true;
    if (runtimeRuns(node, scope) && stringsIn(argsOf(node)).some((text) => NET_TOOL.test(text)))
      return true;
  }
  const callee = node.callee as JsNode;
  if (callee.type === "Identifier" && !modules.isBound(String(callee.name))) {
    if (
      callee.name === "fetch" ||
      callee.name === "XMLHttpRequest" ||
      callee.name === "WebSocket" ||
      callee.name === "EventSource"
    )
      return true;
    if (callee.name === "axios" || callee.name === "got") return true;
  }
  const ref = calleeRef(node, modules);
  if (ref?.module === "network") {
    const last = ref.path.at(-1);
    if (last === undefined || NET_METHOD.test(last)) return true;
  }
  // A bound child_process running a network tool.
  if (isExecCall(node, modules) && stringsIn(argsOf(node)).some((text) => NET_TOOL.test(text)))
    return true;
  if (callee.type === "MemberExpression") {
    const object = callee.object as JsNode;
    const name = idName(callee.property as JsNode);
    const objectName = idName(object);
    if (
      (objectName === "http" ||
        objectName === "https" ||
        objectName === "axios" ||
        objectName === "got" ||
        objectName === "dns") &&
      name !== undefined &&
      NET_METHOD.test(name)
    )
      return true;
    if (name === "send" || name === "sendBeacon") return true;
    // child_process exec/spawn running a network tool: checked by the shell rules on the string,
    // but a literal here is a sink too.
    if (name && /^(?:exec|execSync|spawn|spawnSync|execFile)$/.test(name)) {
      const arg = argsOf(node)[0];
      const text = arg ? stringValue(arg) : undefined;
      if (text && NET_TOOL.test(text)) return true;
    }
  }
  return false;
}

/** A held finding (a warn): the scanner couldn't follow this executable code all the way. */
const heldHit = (message: string, line?: number): FlowHit => ({
  ...(line ? { line } : {}),
  level: HELD_LEVEL,
  message,
});

/**
 * The finding for an analysis a cap cut short (ADR 0173 §8, fails closed): the code it didn't read
 * could run, so the entry is blocked, the `scan-truncated` level, until it can be read whole.
 */
export const cutShort = (path: string): FlowHit => ({
  level: TRUNCATED_LEVEL,
  truncated: true,
  message: `${path} is too large for the scanner to read whole, so it is blocked until it can be`,
});

/**
 * The JS/TS flow rule: parse, bind module identities, find where a sensitive value is bound, then
 * whether a network sink reaches one. It fails closed: an executable file it can't parse, can't
 * walk whole, or that reads a sensitive module in a way it can't resolve beside any sink, is held.
 */
export function jsFlow(view: ScriptView): FlowHit[] {
  const typescript = /\.(?:ts|tsx|mts|cts)$/.test(view.path) || view.language === "javascript";
  const parsed = parseJs(view.text, { typescript });
  const mentionsSource =
    WHOLE_ENV.test(view.text) ||
    /\b(?:Deno|Bun)\.env\b|\bimport\.meta\.env\b|\bprocess\.env\b/.test(view.text) ||
    credentialPath.test(view.text) ||
    /\b(?:homedir|userInfo)\s*\(/.test(view.text);
  const mentionsSink =
    /\b(?:fetch|XMLHttpRequest|WebSocket|axios|got|sendBeacon)\b|\b(?:https?|dns)\.(?:request|get|post|lookup|resolve)/.test(
      view.text,
    );
  if (!parsed) {
    // Executable JavaScript or TypeScript (a script file or a tagged code fence) the parser
    // can't read is held whatever it mentions; a `text` view is read this way only on a hunch.
    if (view.language === "javascript")
      return [heldHit(`${view.path} is code the scanner can't parse, so it is held`)];
    if (mentionsSource && mentionsSink)
      return [
        heldHit(
          `${view.path} reads something sensitive and reaches the network in code the scanner can't follow`,
        ),
      ];
    return [];
  }
  return analyse(view, parsed.program, mentionsSource, mentionsSink);
}

/** The flow analysis over a parsed program; exported for the node-cap test. */
export function analyse(
  view: ScriptView,
  program: JsNode,
  mentionsSource: boolean,
  mentionsSink: boolean,
  walker: typeof walk = walk,
): FlowHit[] {
  const modules = bindModules(program, walker);
  let cut = modules.truncated;
  const visit = (root: JsNode, fn: Parameters<typeof walk>[1]) => {
    if (!walker(root, fn)) cut = true;
  };
  const scope: FlowScope = { modules, declared: declaredNames(program, walker) };
  /** What a node reads directly, through a tracked module or a runtime global. */
  const readOf = (node: JsNode, parent: JsNode | undefined) =>
    worse(moduleSeverity(node, parent, modules), runtimeSeverity(node, parent, scope));

  // Bindings tainted by a sensitive source, by severity, to a fixpoint over the file. A name
  // bound to a module is left to the module references, which know `e.KEY` from `e` whole.
  const taint = new Map<string, Severity>();
  const bump = (name: string, severity: Severity) => {
    if (modules.isBound(name)) return;
    const had = taint.get(name);
    if (worse(had, severity) !== had) taint.set(name, severity);
  };
  const exprSeverity = (node: JsNode): Severity | undefined => {
    let worst: Severity | undefined;
    visit(node, (child, parent) => {
      const at = child === node ? undefined : parent;
      worst = worse(
        worst,
        worse(
          readOf(child, at),
          sourceSeverity(child, view.text.slice(child.start ?? 0, (child.start ?? 0) + 120)),
        ),
      );
      const cn = idName(child);
      if (cn && isReference(child, parent)) {
        worst = worse(worst, taint.get(cn));
        // A value from a package the scanner doesn't track: it can't prove what it holds.
        if (modules.isForeign(cn)) worst = worse(worst, "unproven");
      }
    });
    return worst;
  };
  const weight = () => [...taint.values()].reduce((sum, value) => sum + RANK[value], 0);
  for (let pass = 0; pass < 6; pass++) {
    const before = weight();
    visit(program, (node) => {
      if (node.type === "VariableDeclarator") {
        const id = node.id as JsNode;
        const init = node.init as JsNode | null;
        if (!init) return;
        const severity = exprSeverity(init);
        if (!severity) return;
        const bound = new Set<string>();
        patternNames(id, bound);
        for (const name of bound) bump(name, severity);
      }
      if (node.type === "AssignmentExpression") {
        const left = node.left as JsNode;
        const right = node.right as JsNode;
        const severity = exprSeverity(right);
        if (severity && left.type === "Identifier" && typeof left.name === "string")
          bump(left.name, severity);
      }
    });
    if (weight() === before) break;
  }

  const hits: FlowHit[] = [];
  let connected = false;
  let netSink = mentionsSink;
  let runs = false;
  let sourceSeen: Severity | undefined;
  visit(program, (node, parent) => {
    sourceSeen = worse(sourceSeen, readOf(node, parent));
    const net = sinkOf(node, modules, scope);
    const runsHere = !net && (isExecCall(node, modules) || runtimeRuns(node, scope));
    if (runsHere) runs = true;
    if (!net && !runsHere) return;
    if (net) netSink = true;
    let worst: Severity | undefined;
    for (const argument of sinkArgs(node)) worst = worse(worst, exprSeverity(argument));
    if (!worst) return;
    connected = true;
    const line = lineOf(node);
    if (net && worst === "severe")
      hits.push({
        ...(line ? { line } : {}),
        level: "block",
        message: `${view.path} sends your environment, credentials or home files to the network`,
      });
    else if (!net)
      hits.push(
        heldHit(
          `${view.path} hands a program it runs a value the scanner can't prove harmless`,
          line,
        ),
      );
    else if (worst === "mild")
      hits.push(heldHit(`${view.path} sends a secret value to the network`, line));
    else
      hits.push(
        heldHit(`${view.path} sends the network a value the scanner can't prove harmless`, line),
      );
  });
  // A source and a sink, but no connection the parser could make: held, not passed.
  if (!connected && (netSink || runs) && (sourceSeen || (netSink && mentionsSource)))
    hits.push(
      heldHit(
        `${view.path} reads something the scanner can't prove harmless and ${netSink ? "reaches the network" : "runs programs"}; the scanner can't rule out that they meet`,
      ),
    );
  // A sensitive module read the scanner can't resolve, beside any sink: held, never passed.
  const unresolved = modules.unresolved[0];
  if (unresolved && (netSink || runs))
    hits.push(
      heldHit(
        `${view.path} makes a read the scanner can't resolve (${unresolved.what}) in a file that reaches the network or runs programs`,
        unresolved.line,
      ),
    );
  if (cut) hits.push(cutShort(view.path));
  return hits;
}

/* ---------------------------------------------------------------- shell and Python */

/*
 * Shell and Python are read by proximity, failing closed the same way: a file with a network or
 * program sink and any read the scanner can't prove harmless is held; a read that clearly carries
 * the whole environment or a credential to the network is a block.
 */

const secretReader =
  /\b(?:env|printenv|set|security\s+(?:find-|dump-)|(?:cat|head|tail|base64|xxd|od|strings|tr)\s+[^\n|]*(?:\.ssh\/|\.aws\/|\.env|id_(?:rsa|ed25519)|credentials|\/proc\/[^\s|/]+\/environ))|<\s*\/proc\/[^\s|/]+\/environ/;
const netSink = /\b(?:curl|wget|nc|ncat|netcat|socat|telnet)\b|\/dev\/(?:tcp|udp)\//;
/** A network tool handed a secret file to upload (`curl -d @/proc/self/environ`, `-T ~/.ssh/…`). */
const uploadsSecret =
  /(?:@|\s-T\s*|--upload-file\s+)["']?(?:\/proc\/[^\s/]+\/environ|~\/\.(?:ssh|aws|netrc|env)|\$\{?HOME\}?\/\.(?:ssh|aws|netrc|env))/;
/** Shell lines whose output or input is a value the scanner can't prove harmless. */
const shellUnproven: readonly RegExp[] = [
  // A whole-environment dump at a command position (not `#!/usr/bin/env bash`, not `env X=1 cmd`).
  /(?:^|[;&|(`]|\$\()\s*(?:env|printenv|set|export\s+-p|declare\s+-[px]+|typeset\s+-x|compgen\s+-[ve])\s*(?:$|[|>;&)`])/,
  /(?:^|[;&|(`]|\$\()\s*printenv\b/,
  /\/proc\/[^\s/]+\/(?:environ|cmdline|maps|mem)\b/,
  /\bsecurity\s+(?:find|dump)-|\bkeychain\b|\bsecret-tool\b|\bpass\s+show\b/,
  // Reading a file under home, `/etc`, a credential name, or at a path held in a variable.
  /(?:^|[;&|(`]|\$\()\s*(?:cat|head|tail|less|more|base64|xxd|od|strings|tar|zip|gpg|openssl|cp|scp)\s+[^\n;|]*(?:~\/|\$\{?HOME\b|\/etc\/|\.ssh|\.aws|\.netrc|\.env\b|credentials|id_rsa|\$\{?[A-Za-z_])/,
  /\$\(\s*<|<\s*(?:~\/|\$\{?HOME\b|\$\{?[A-Za-z_])/,
];
const isComment = (line: string) => /^\s*#/.test(line);

/** A shell view: a secret reader whose output is piped or command-substituted into a network tool. */
export function shellFlow(view: ScriptView): FlowHit[] {
  const hits: FlowHit[] = [];
  for (const [index, raw] of view.lines.entries()) {
    if (raw.length > 20_000) {
      // A cap that drops a line of a script drops what it runs: blocked until read whole.
      hits.push({
        line: index + 1,
        level: TRUNCATED_LEVEL,
        truncated: true,
        message: `${view.path} line ${index + 1} is too long for the scanner to read whole, so it is blocked until it can be`,
      });
      continue;
    }
    const text = raw;
    // `env | curl …`, `security find-generic-password … | curl`, `curl -d "$(env)"`.
    const piped =
      secretReader.test(text) && /\|/.test(text) && netSink.test(text.slice(text.indexOf("|")));
    const substituted =
      netSink.test(text) &&
      /\$\(\s*(?:env|printenv|cat\s+[^)]*(?:\.ssh|\.aws|\.env|credentials|\/proc\/[^\s)/]+\/environ))/.test(
        text,
      );
    const uploaded = netSink.test(text) && uploadsSecret.test(text);
    const varThenSend = /\b[A-Za-z_][A-Za-z0-9_]*=\$\(\s*(?:env|printenv|cat\s)/.test(text);
    if (piped || substituted || uploaded)
      hits.push({
        line: index + 1,
        level: "block",
        message: `${view.path} line ${index + 1} sends your environment or credentials to the network`,
      });
    else if (varThenSend && view.lines.some((l) => netSink.test(l)))
      hits.push({
        line: index + 1,
        level: "warn",
        message: `${view.path} line ${index + 1} puts your environment in a variable near a network command`,
      });
  }
  return hits;
}

/** A shell script's proximity hold: a network sink and a read it can't prove harmless. */
function shellProximity(view: ScriptView): FlowHit[] {
  const sink = view.lines.findIndex((line) => !isComment(line) && netSink.test(line));
  if (sink < 0) return [];
  const read = view.lines.findIndex(
    (line) => !isComment(line) && shellUnproven.some((pattern) => pattern.test(line)),
  );
  if (read < 0) return [];
  return [
    heldHit(
      `${view.path} line ${read + 1} reads something the scanner can't prove harmless in a script that reaches the network`,
      read + 1,
    ),
  ];
}

const pySink =
  /\brequests\.\w+\s*\(|\burllib(?:3)?(?:\.request)?\.\w+|\bhttp(?:lib|x)?\.|\baiohttp\b|\bsocket\.\w+|\b(?:smtplib|ftplib|telnetlib|paramiko|websockets?|pycurl)\b|\bcreate_connection\s*\(/;
const pyRuns =
  /\bsubprocess\.\w+|\bos\.(?:system|popen|exec\w*|spawn\w*|posix_spawn\w*)\s*\(|\bpty\.spawn\b|\bcreate_subprocess_\w+|\bcommands\.getoutput\b/;
/** Python reads that clearly hand on the whole environment or a credential file. */
const pyWhole =
  /\b(?:os\.)?environ\b(?!\s*(?:\.get\s*\(|\[|\.setdefault\s*\(|\.pop\s*\())|\bgetattr\s*\(\s*os\s*,\s*["']environ["']\s*\)(?!\s*(?:\.get\s*\(|\[))|open\s*\([^)\n]*(?:\.ssh|\.aws|\.env|\.netrc|credentials|id_rsa|\/proc\/[^\s/)]+\/environ)|\bPath\.home\s*\(|expanduser\s*\(\s*["']~["']\s*\)/;
/** Python reads the scanner can't prove harmless. */
const pyUnproven =
  /\b(?:os\.)?environ\b|\bgetenv\s*\(|\bgetattr\s*\(|\b__import__\s*\(|\bimportlib\b|\b(?:globals|vars|locals)\s*\(\s*\)|\bexpand(?:user|vars)\s*\(|\bkeyring\b|\bPath\.home\b|\.read_(?:text|bytes)\s*\(|\bopen\s*\(\s*(?!["'](?![/~])[^"'$]*["'])|\/proc\/|\bpwd\.getpw|\bgetpass\.getuser\b|\bsocket\.gethostname\b/;

/** A Python view: a sensitive read and a network or program sink in the same file. */
export function pyFlow(view: ScriptView): FlowHit[] {
  const network = pySink.test(view.text) || (pyRuns.test(view.text) && NET_TOOL.test(view.text));
  const runs = pyRuns.test(view.text);
  if (!network && !runs) return [];
  if (!pyUnproven.test(view.text) && !pyWhole.test(view.text)) return [];
  const whole = pyWhole.test(view.text);
  const named = /\bos\.environ\s*(?:\.get\s*\(|\[)\s*["']|\bgetenv\s*\(\s*["']/.test(view.text);
  const sinkLine = view.lines.findIndex((l) => pySink.test(l) || pyRuns.test(l));
  const line = sinkLine >= 0 ? { line: sinkLine + 1 } : {};
  if (whole && network)
    return [
      {
        ...line,
        level: "block",
        message: `${view.path} sends your environment or credentials to the network`,
      },
    ];
  return [
    {
      ...line,
      level: HELD_LEVEL,
      message:
        named && !whole
          ? `${view.path} reads something sensitive and reaches the network`
          : `${view.path} reads something the scanner can't prove harmless and ${network ? "reaches the network" : "runs programs"}`,
    },
  ];
}

/** Every flow finding for one view, by its language. */
export function dataflow(view: ScriptView): FlowHit[] {
  switch (view.language) {
    case "javascript":
      return jsFlow(view);
    case "shell": {
      const hits = shellFlow(view);
      return hits.length > 0 ? hits : shellProximity(view);
    }
    case "python":
      return pyFlow(view);
    case "text":
      // An unknown-language file is read both ways; the JS parser reads the most.
      return [...jsFlow(view), ...shellFlow(view)];
    default:
      return [];
  }
}
