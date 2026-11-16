import { lineOf, parseJs, walk, type JsNode } from "./js-ast.ts";
import {
  bindModules,
  isReference,
  literalString,
  type ModuleBindings,
  type ModuleRef,
} from "./module-identity.ts";

const NET_METHOD =
  /^(?:fetch|request|get|post|put|send|sendBeacon|lookup|resolve|resolve4|resolve6|openSync|connect)$/;

import { HELD_LEVEL } from "./fail-closed.ts";
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
 * Pure: a parser for JavaScript and TypeScript, line patterns for Python and shell.
 */

export type FlowLevel = "block" | "warn";
export interface FlowHit {
  line?: number;
  level: FlowLevel;
  message: string;
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

/** The sensitive severity a node reads directly: the whole environment, a file or home, or a key. */
type Severity = "severe" | "mild";
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
    if (callee?.module === "fs" && last && FS_READ.test(last))
      return stringsIn(argsOf(node)).some((text) => credentialPath.test(text))
        ? "severe"
        : undefined;
    if (isExecCall(node, modules))
      return stringsIn(argsOf(node)).some(
        (text) => credentialPath.test(text) || SECRET_COMMAND.test(text),
      )
        ? "severe"
        : undefined;
  }
  const ref = modules.refOf(node);
  if (!ref || narrowedBy(node, parent)) return undefined;
  const [first] = ref.path;
  switch (ref.module) {
    case "process":
      if (first !== "env") return undefined;
      return ref.path.length === 1 ? "severe" : "mild";
    case "os":
      return first === "homedir" || first === "userInfo" ? "severe" : undefined;
    case "keychain":
      return first !== undefined && /^(?:get|find)/i.test(first) ? "severe" : undefined;
    default:
      return undefined;
  }
}

/** Whether a call is a network sink: a known client, a bound network module, a network tool run. */
function sinkOf(node: JsNode, modules: ModuleBindings): boolean {
  if (node.type !== "CallExpression" && node.type !== "NewExpression") return false;
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

/** The identifier names a node reads, for taint propagation. */
function identifiersIn(node: JsNode): string[] {
  const names: string[] = [];
  walk(node, (child, parent) => {
    const n = idName(child);
    if (n && isReference(child, parent)) names.push(n);
  });
  return names;
}

/** A held finding (a warn): the scanner couldn't follow this executable code all the way. */
const heldHit = (message: string, line?: number): FlowHit => ({
  ...(line ? { line } : {}),
  level: HELD_LEVEL,
  message,
});

/** The held finding for an analysis a walk cut short (ADR 0173 §8, fails closed). */
export const cutShort = (path: string): FlowHit =>
  heldHit(`${path} is too large for the scanner to follow all the way, so it is held`);

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

  // Bindings tainted by a sensitive source, by severity, to a fixpoint over the file. A name
  // bound to a module is left to the module references, which know `e.KEY` from `e` whole.
  const taint = new Map<string, Severity>();
  const bump = (name: string, severity: Severity) => {
    if (modules.isBound(name)) return;
    const had = taint.get(name);
    if (had === "severe") return;
    if (!had || severity === "severe") taint.set(name, severity);
  };
  let sourceSeen = false;
  const exprSeverity = (node: JsNode): Severity | undefined => {
    let worst: Severity | undefined;
    visit(node, (child, parent) => {
      const direct =
        moduleSeverity(child, child === node ? undefined : parent, modules) ??
        sourceSeverity(child, view.text.slice(child.start ?? 0, (child.start ?? 0) + 120));
      if (direct === "severe") worst = "severe";
      else if (direct === "mild" && worst !== "severe") worst = "mild";
      const cn = idName(child);
      if (cn && isReference(child, parent)) {
        const t = taint.get(cn);
        if (t === "severe") worst = "severe";
        else if (t === "mild" && worst !== "severe") worst = "mild";
      }
    });
    return worst;
  };
  for (let pass = 0; pass < 6; pass++) {
    const before = taint.size + [...taint.values()].filter((v) => v === "severe").length;
    visit(program, (node) => {
      if (node.type === "VariableDeclarator") {
        const id = node.id as JsNode;
        const init = node.init as JsNode | null;
        const idn = idName(id);
        if (idn && init) {
          const severity = exprSeverity(init);
          if (severity) bump(idn, severity);
        }
      }
      if (node.type === "AssignmentExpression") {
        const left = node.left as JsNode;
        const right = node.right as JsNode;
        const severity = exprSeverity(right);
        if (severity && left.type === "Identifier" && typeof left.name === "string")
          bump(left.name, severity);
      }
    });
    const after = taint.size + [...taint.values()].filter((v) => v === "severe").length;
    if (after === before) break;
  }

  const hits: FlowHit[] = [];
  let connected = false;
  let netSink = mentionsSink;
  let runs = false;
  visit(program, (node, parent) => {
    if (!sourceSeen && moduleSeverity(node, parent, modules)) sourceSeen = true;
    if (isExecCall(node, modules)) runs = true;
    if (!sinkOf(node, modules)) return;
    netSink = true;
    let worst: Severity | undefined;
    for (const argument of argsOf(node)) {
      const severity = exprSeverity(argument);
      if (severity === "severe") worst = "severe";
      else if (severity === "mild" && worst !== "severe") worst = worst ?? "mild";
      for (const name of identifiersIn(argument)) {
        const t = taint.get(name);
        if (t === "severe") worst = "severe";
        else if (t === "mild" && worst !== "severe") worst = worst ?? "mild";
      }
    }
    if (worst === "severe") {
      connected = true;
      const line = lineOf(node);
      hits.push({
        ...(line ? { line } : {}),
        level: "block",
        message: `${view.path} sends your environment, credentials or home files to the network`,
      });
    } else if (worst === "mild") {
      connected = true;
      hits.push(heldHit(`${view.path} sends a secret value to the network`, lineOf(node)));
    }
  });
  // Both a source and a sink, but no connection the parser could make: held, not passed.
  if (!connected && (mentionsSource || sourceSeen) && netSink)
    hits.push(
      heldHit(
        `${view.path} reads something sensitive and reaches the network; the scanner can't rule out that they meet`,
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

const secretReader =
  /\b(?:env|printenv|set|security\s+(?:find-|dump-)|cat\s+[^\n|]*(?:\.ssh\/|\.aws\/|\.env|id_(?:rsa|ed25519)|credentials))/;
const netSink = /\b(?:curl|wget|nc|ncat|netcat|socat)\b/;

/** A shell view: a secret reader whose output is piped or command-substituted into a network tool. */
export function shellFlow(view: ScriptView): FlowHit[] {
  const hits: FlowHit[] = [];
  for (const [index, raw] of view.lines.entries()) {
    const text = raw.length > 20_000 ? raw.slice(0, 20_000) : raw;
    // `env | curl …`, `security find-generic-password … | curl`, `curl -d "$(env)"`.
    const piped =
      secretReader.test(text) && /\|/.test(text) && netSink.test(text.slice(text.indexOf("|")));
    const substituted =
      netSink.test(text) &&
      /\$\(\s*(?:env|printenv|cat\s+[^)]*(?:\.ssh|\.aws|\.env|credentials))/.test(text);
    const varThenSend = /\b[A-Za-z_][A-Za-z0-9_]*=\$\(\s*(?:env|printenv|cat\s)/.test(text);
    if (piped || substituted)
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

const pySource =
  /\bos\.environ\b|\bos\.path\.expanduser\s*\(\s*["'`]~|open\s*\([^)\n]*(?:\.ssh|\.aws|\.env|credentials|id_rsa)/;
const pySink =
  /\brequests\.(?:post|put|get)\s*\(|\burllib(?:\.request)?\.urlopen\s*\(|\bhttp(?:lib|x)\.|\bsocket\.socket\s*\(/;

/** A Python view: a sensitive read and a network call close together. */
export function pyFlow(view: ScriptView): FlowHit[] {
  if (!pySource.test(view.text) || !pySink.test(view.text)) return [];
  const whole =
    /\bos\.environ\b(?!\s*(?:\.get\s*\(|\[))|dict\s*\(\s*os\.environ|open\s*\([^)\n]*(?:\.ssh|\.aws|\.env|credentials|id_rsa)/.test(
      view.text,
    );
  const sinkLine = view.lines.findIndex((l) => pySink.test(l));
  return [
    {
      ...(sinkLine >= 0 ? { line: sinkLine + 1 } : {}),
      level: whole ? "block" : "warn",
      message: whole
        ? `${view.path} sends your environment or credentials to the network`
        : `${view.path} reads something sensitive and reaches the network`,
    },
  ];
}

/** Every flow finding for one view, by its language. */
export function dataflow(view: ScriptView): FlowHit[] {
  switch (view.language) {
    case "javascript":
      return jsFlow(view);
    case "shell":
      return shellFlow(view);
    case "python":
      return pyFlow(view);
    case "text":
      // An unknown-language file is read both ways; the JS parser reads the most.
      return [...jsFlow(view), ...shellFlow(view)];
    default:
      return [];
  }
}
