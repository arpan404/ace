import { parse } from "@babel/parser";

/*
 * JavaScript and TypeScript as the scanner reads them (ADR 0173 §8): one real parser, shared by
 * the data-flow rules and the Suit scene allowlist. Pure, no I/O, the same on the Worker, the
 * signer and the device. A file the parser can't read is answered as `undefined`, and the caller
 * must treat that as a finding, never as a pass.
 */

/** A parsed node: its `type`, its source position and its child fields. */
export interface JsNode {
  type: string;
  start?: number | null;
  loc?: { start: { line: number } } | null;
  [field: string]: unknown;
}

/** The most source the parser reads; longer is the caller's `too-long` finding. */
export const parseCap = 1024 * 1024;
/** The most nodes a walk visits, so a pathological file stays bounded. */
export const nodeCap = 500_000;

export interface Parsed {
  program: JsNode;
  /** The parser recovered from errors: some text may not be in the tree. */
  recovered: boolean;
}

/** Parses `text` as a module (falling back to a script), JSX and TypeScript allowed. */
export function parseJs(text: string, options: { typescript: boolean }): Parsed | undefined {
  if (text.length > parseCap) return undefined;
  const plugins: ("jsx" | "typescript")[] = options.typescript ? ["typescript"] : ["jsx"];
  for (const sourceType of ["module", "script"] as const) {
    try {
      const file = parse(text, {
        sourceType,
        plugins,
        errorRecovery: true,
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true,
      });
      return {
        program: file.program as unknown as JsNode,
        recovered: (file.errors?.length ?? 0) > 0,
      };
    } catch {
      // Try the other source type; then give up.
    }
  }
  return undefined;
}

const isNode = (value: unknown): value is JsNode =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { type?: unknown }).type === "string";

/**
 * Every node under `root`, depth first, with its parent, at most `nodeCap` of them. Returns
 * false when the cap cut the walk short.
 */
export function walk(
  root: JsNode,
  visit: (node: JsNode, parent: JsNode | undefined) => void,
): boolean {
  const stack: [JsNode, JsNode | undefined][] = [[root, undefined]];
  let seen = 0;
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) break;
    const [node, parent] = item;
    if (++seen > nodeCap) return false;
    visit(node, parent);
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc" || key === "extra" || key === "leadingComments") continue;
      if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index--) {
          const child: unknown = value[index];
          if (isNode(child)) stack.push([child, node]);
        }
      } else if (isNode(value)) stack.push([value, node]);
    }
  }
  return true;
}

/** The 1-based line a node starts on. */
export const lineOf = (node: JsNode): number | undefined => node.loc?.start.line;
