import { generate, parse, type CssNode, type Declaration } from "css-tree";
import type { SuitProblem } from "@ace/protocol/suits";
import { suitLimits } from "../limits.ts";
import { checkMedia } from "./media.ts";
import { checkSelectors, touchesProtected } from "./selectors.ts";
import {
  checkDeclaration,
  checkFontFaceDeclaration,
  framesOnly,
  isAnimation,
  type ValueContext,
} from "./values.ts";

/*
 * A Suit's suit.css made safe to apply (ADR 0150, "suit.css"). The file is parsed, never applied
 * as text: each rule is checked, scoped to `[data-suit="<id>"]` and printed again, and each
 * thing refused comes back as a `SuitProblem` with its line so an agent can fix it. The client
 * wraps the result in `@layer suit`. Pure: the caller hands in the asset list and their URLs.
 */

export interface SuitCssInput {
  id: string;
  text: string;
  /** Asset paths the Suit holds (`assets/...`). */
  assets: ReadonlySet<string>;
  /** The served URL of an asset path. */
  url(path: string): string;
}

export interface SuitCss {
  /** The rules that survived, ready to wrap in `@layer suit`; empty when none did. */
  css: string;
  problems: SuitProblem[];
}

const field = "suit.css";
const refuse = (message: string, line: number | undefined): SuitProblem =>
  line === undefined
    ? { scheme: null, check: "css", field, message }
    : { scheme: null, check: "css", field, line, message };

const lineOf = (node: CssNode): number | undefined => node.loc?.start.line;
const keyframeName = /^[A-Za-z_][A-Za-z0-9_-]{0,60}$/;

export function sanitiseSuitCss(input: SuitCssInput): SuitCss {
  const bytes = new TextEncoder().encode(input.text).byteLength;
  if (bytes > suitLimits.cssBytes)
    return {
      css: "",
      problems: [
        refuse(`suit.css is ${bytes} bytes; the limit is ${suitLimits.cssBytes}`, undefined),
      ],
    };
  const problems: SuitProblem[] = [];
  const sheet = parse(input.text, {
    positions: true,
    parseCustomProperty: true,
    onParseError: (error) => {
      const line = "line" in error && typeof error.line === "number" ? error.line : undefined;
      problems.push(refuse(`this doesn't parse as CSS: ${error.message}`, line));
    },
  });
  if (sheet.type !== "StyleSheet") return { css: "", problems };

  // Keyframe names first, so an animation may name keyframes written later in the file.
  const keyframes = new Map<string, string>();
  collectKeyframes(sheet, input.id, keyframes);
  const context: ValueContext = { assets: input.assets, url: input.url, keyframes };
  const out: string[] = [];
  for (const node of sheet.children) out.push(...topLevel(node, input.id, context, problems));
  // Printed CSS goes into a <style>; `</` never closes it, even if replayed through HTML.
  return { css: out.join("\n").replaceAll("</", "<\\/"), problems };
}

function collectKeyframes(node: CssNode, id: string, into: Map<string, string>) {
  if (
    node.type !== "StyleSheet" &&
    !(node.type === "Atrule" && node.name.toLowerCase() === "media")
  )
    return;
  const children = node.type === "StyleSheet" ? node.children : node.block?.children;
  for (const child of children ?? []) {
    if (child.type === "Atrule" && isKeyframes(child.name)) {
      const name = preludeName(child.prelude);
      if (name && keyframeName.test(name)) into.set(name, `suit-${id}-${name}`);
    } else collectKeyframes(child, id, into);
  }
}

const isKeyframes = (name: string) => /^(-webkit-)?keyframes$/i.test(name);

function preludeName(prelude: CssNode | null): string | undefined {
  if (!prelude || prelude.type !== "AtrulePrelude") return undefined;
  const only = prelude.children.first;
  if (prelude.children.size !== 1 || !only) return undefined;
  if (only.type === "Identifier") return only.name;
  if (only.type === "String") return only.value;
  return undefined;
}

/** One top-level or `@media`-nested item as printed CSS, or nothing if it was refused. */
function topLevel(
  node: CssNode,
  id: string,
  context: ValueContext,
  problems: SuitProblem[],
): string[] {
  if (node.type === "Rule") return rule(node, id, context, problems);
  if (node.type !== "Atrule") {
    problems.push(refuse("this doesn't parse as a rule", lineOf(node)));
    return [];
  }
  const name = node.name.toLowerCase();
  const line = lineOf(node);
  if (name === "media") {
    const reason = checkMedia(node.prelude);
    if (reason) {
      problems.push(refuse(reason, line));
      return [];
    }
    const inner = (node.block?.children.toArray() ?? []).flatMap((child) =>
      topLevel(child, id, context, problems),
    );
    if (inner.length === 0 || !node.prelude) return [];
    return [`@media ${generate(node.prelude)}{${inner.join("")}}`];
  }
  if (isKeyframes(name)) return keyframesRule(node, context, problems);
  if (name === "font-face") return fontFace(node, context, problems);
  if (name === "import") {
    problems.push(refuse("@import is not allowed; a Suit is one file", line));
    return [];
  }
  problems.push(
    refuse(
      `@${name} is not allowed; suit.css takes rules, @media, @keyframes and @font-face`,
      line,
    ),
  );
  return [];
}

function rule(
  node: Extract<CssNode, { type: "Rule" }>,
  id: string,
  context: ValueContext,
  problems: SuitProblem[],
): string[] {
  const verdict = checkSelectors(node.prelude, id);
  if (!verdict.ok) {
    problems.push(refuse(verdict.reason, lineOf(node)));
    return [];
  }
  const guarded = verdict.selectors.some((selector) => touchesProtected(selector.parts));
  const still: string[] = [];
  const moving: string[] = [];
  for (const child of node.block.children) {
    if (child.type !== "Declaration") {
      problems.push(
        refuse("nested rules aren't supported; write each rule in full", lineOf(child)),
      );
      continue;
    }
    if (guarded && !framesOnly(child.property)) {
      problems.push(
        refuse(
          `${child.property} can't be set on an agent-state part (approval strip, Working line, question card, status icon); a Suit may only frame them`,
          lineOf(child),
        ),
      );
      continue;
    }
    const text = declaration(child, context, problems, checkDeclaration);
    if (text === undefined) continue;
    (isAnimation(child.property) ? moving : still).push(text);
  }
  const selectors = verdict.selectors.map((selector) => selector.scoped);
  const out: string[] = [];
  if (still.length > 0) out.push(`${selectors.join(",")}{${still.join(";")}}`);
  // A Suit's animations run only while the device allows motion.
  if (moving.length > 0)
    out.push(
      `${selectors.map((selector) => selector.replace(`[data-suit="${id}"]`, `[data-suit="${id}"]:not([data-reduce-motion])`)).join(",")}{${moving.join(";")}}`,
    );
  return out;
}

function declaration(
  node: Declaration,
  context: ValueContext,
  problems: SuitProblem[],
  check: (node: Declaration, context: ValueContext) => string | undefined,
): string | undefined {
  const reason = check(node, context);
  if (reason) {
    problems.push(refuse(reason, lineOf(node)));
    return undefined;
  }
  return generate(node);
}

function keyframesRule(
  node: Extract<CssNode, { type: "Atrule" }>,
  context: ValueContext,
  problems: SuitProblem[],
): string[] {
  const name = preludeName(node.prelude);
  const scoped = name === undefined ? undefined : context.keyframes.get(name);
  if (!scoped) {
    problems.push(refuse("@keyframes needs a plain name (letters, digits, - and _)", lineOf(node)));
    return [];
  }
  const frames: string[] = [];
  for (const frame of node.block?.children ?? []) {
    if (frame.type !== "Rule" || frame.prelude.type !== "SelectorList") {
      problems.push(refuse("a keyframe is from, to or a percentage", lineOf(frame)));
      continue;
    }
    const stops = generate(frame.prelude);
    if (!/^(from|to|\d{1,3}(\.\d+)?%)(,(from|to|\d{1,3}(\.\d+)?%))*$/i.test(stops)) {
      problems.push(refuse("a keyframe is from, to or a percentage", lineOf(frame)));
      continue;
    }
    const body: string[] = [];
    for (const child of frame.block.children) {
      if (child.type !== "Declaration") continue;
      const text = declaration(child, context, problems, checkDeclaration);
      if (text !== undefined) body.push(text);
    }
    frames.push(`${stops}{${body.join(";")}}`);
  }
  return [`@keyframes ${scoped}{${frames.join("")}}`];
}

function fontFace(
  node: Extract<CssNode, { type: "Atrule" }>,
  context: ValueContext,
  problems: SuitProblem[],
): string[] {
  const body: string[] = [];
  let wrote = false;
  let kept = false;
  for (const child of node.block?.children ?? []) {
    if (child.type !== "Declaration") continue;
    const source = child.property.toLowerCase() === "src";
    wrote ||= source;
    const text = declaration(child, context, problems, checkFontFaceDeclaration);
    if (text === undefined) continue;
    kept ||= source;
    body.push(text);
  }
  if (!kept) {
    // A refused src is already a problem of its own.
    if (!wrote)
      problems.push(refuse("@font-face needs a src from the Suit's assets/", lineOf(node)));
    return [];
  }
  return [`@font-face{${body.join(";")}}`];
}
