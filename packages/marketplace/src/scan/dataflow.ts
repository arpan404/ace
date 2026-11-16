import { lineOf, parseJs, walk, type JsNode } from "./js-ast.ts";

const NET_METHOD =
  /^(?:fetch|request|get|post|put|send|sendBeacon|lookup|resolve|resolve4|resolve6|openSync|connect)$/;

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
  // `process.env`: a single value (`process.env.FOO`, mild) or the whole environment (severe),
  // told apart by whether this member is `process.env` itself narrowed by a further `.FOO`/`[x]`.
  if (node.type === "MemberExpression") {
    const object = node.object as JsNode;
    if (idName(object) === "process" && idName(node.property as JsNode) === "env") {
      const after = source.slice(0, 60).replace(/^.*?process\s*\.\s*env/s, "");
      return /^\s*(?:\.\s*[A-Za-z_$]|\[)/.test(after) ? "mild" : "severe";
    }
  }
  if (idName(node) === "env") return undefined;
  // os.homedir(), os.userInfo()
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

/** Whether a call is a network sink, and the text of its program when it shells out. */
function sinkOf(node: JsNode): boolean {
  if (node.type !== "CallExpression" && node.type !== "NewExpression") return false;
  const callee = node.callee as JsNode;
  if (callee.type === "Identifier") {
    if (
      callee.name === "fetch" ||
      callee.name === "XMLHttpRequest" ||
      callee.name === "WebSocket" ||
      callee.name === "EventSource"
    )
      return true;
    if (callee.name === "axios" || callee.name === "got") return true;
  }
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
      const arg = (node.arguments as JsNode[] | undefined)?.[0];
      const text = arg ? stringValue(arg) : undefined;
      if (text && /\b(?:curl|wget|nc|ncat|netcat|socat)\b/.test(text)) return true;
    }
  }
  return false;
}

/** The identifier names a node reads, for taint propagation. */
function identifiersIn(node: JsNode): string[] {
  const names: string[] = [];
  walk(node, (child) => {
    const n = idName(child);
    if (n) names.push(n);
  });
  return names;
}

/**
 * The JS/TS flow rule: parse, find where a sensitive value is bound, then whether a network sink
 * reaches one. A file the parser can't read, but that mentions both a source and a sink, is a
 * warn — never a pass.
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
    if (mentionsSource && mentionsSink)
      return [
        {
          level: "warn",
          message: `${view.path} reads something sensitive and reaches the network in code the scanner can't follow`,
        },
      ];
    return [];
  }

  // Bindings tainted by a sensitive source, by severity, to a fixpoint over the file.
  const taint = new Map<string, Severity>();
  const bump = (name: string, severity: Severity) => {
    const had = taint.get(name);
    if (had === "severe") return;
    if (!had || severity === "severe") taint.set(name, severity);
  };
  const exprSeverity = (node: JsNode): Severity | undefined => {
    let worst: Severity | undefined;
    walk(node, (child) => {
      const direct = sourceSeverity(
        child,
        view.text.slice(child.start ?? 0, (child.start ?? 0) + 120),
      );
      if (direct === "severe") worst = "severe";
      else if (direct === "mild" && worst !== "severe") worst = "mild";
      const cn = idName(child);
      if (cn) {
        const t = taint.get(cn);
        if (t === "severe") worst = "severe";
        else if (t === "mild" && worst !== "severe") worst = "mild";
      }
    });
    return worst;
  };
  for (let pass = 0; pass < 6; pass++) {
    const before = taint.size + [...taint.values()].filter((v) => v === "severe").length;
    walk(parsed.program, (node) => {
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
  walk(parsed.program, (node) => {
    if (!sinkOf(node)) return;
    let worst: Severity | undefined;
    for (const argument of (node.arguments as JsNode[] | undefined) ?? []) {
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
      const mildLine = lineOf(node);
      hits.push({
        ...(mildLine ? { line: mildLine } : {}),
        level: "warn",
        message: `${view.path} sends a secret value to the network`,
      });
    }
  });
  // Both a source and a sink, but no connection the parser could make: held, not passed.
  if (!connected && mentionsSource && mentionsSink)
    hits.push({
      level: "warn",
      message: `${view.path} reads something sensitive and reaches the network; the scanner can't rule out that they meet`,
    });
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
