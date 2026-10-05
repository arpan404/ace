import type { Plugin } from "vite";

/*
 * Tailwind 4 ships two polyfills for browsers older than the ones it supports (Safari 16.4,
 * Chrome 111, Firefox 128), and `@tailwindcss/vite` has no option to turn them off:
 *
 * - every `color-mix()` declaration is written twice, once with a plain fallback colour and once
 *   inside `@supports (color: color-mix(in lab, red, red))`, so the selector is repeated too;
 * - `@layer properties` resets every `--tw-*` property on `*` for browsers without `@property`.
 *
 * Every browser and Electron build ace runs in has `color-mix()` and `@property`, so the fallbacks
 * never apply; together they were 1.5 KB of the 21 KB gzip CSS budget. Built stylesheets keep the
 * `color-mix()` declaration in place of its fallback and drop the reset layer. Anything that does
 * not have exactly that shape is left alone.
 */

type Node =
  | { kind: "text"; text: string }
  | { kind: "rule"; prelude: string; body: string }
  | { kind: "group"; prelude: string; children: Node[] };

/** At-rules whose body holds rules rather than declarations. */
const groupingAtRules = /^@(media|supports|layer|container|scope|starting-style|document)\b/i;
const colorMixSupports = "@supports(color:color-mix(inlab,red,red))";

/** Index just past the escape, string or comment starting at `i`, or `i` when there is none. */
function skipStringOrComment(css: string, i: number): number {
  const char = css[i];
  // Escaped characters, common in Tailwind selectors such as `.content-\[\"\"\]`.
  if (char === "\\") return i + 2;
  if (char === '"' || char === "'") {
    let j = i + 1;
    while (j < css.length && css[j] !== char) j += css[j] === "\\" ? 2 : 1;
    return j + 1;
  }
  if (char === "/" && css[i + 1] === "*") {
    const end = css.indexOf("*/", i + 2);
    return end === -1 ? css.length : end + 2;
  }
  return i;
}

/** Index of the `}` that closes the block whose `{` is at `open`. */
function closingBrace(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length;) {
    const skipped = skipStringOrComment(css, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return i;
    i++;
  }
  throw new Error("Unbalanced braces in CSS");
}

function parse(css: string): Node[] {
  const nodes: Node[] = [];
  let i = 0;
  while (i < css.length) {
    while (i < css.length && /\s/.test(css[i] ?? "")) i++;
    if (i >= css.length) break;
    if (css.startsWith("/*", i)) {
      const end = skipStringOrComment(css, i);
      nodes.push({ kind: "text", text: css.slice(i, end) });
      i = end;
      continue;
    }
    let j = i;
    let parens = 0;
    while (j < css.length) {
      const skipped = skipStringOrComment(css, j);
      if (skipped !== j) {
        j = skipped;
        continue;
      }
      const char = css[j];
      if (char === "(") parens++;
      else if (char === ")") parens--;
      else if (parens === 0 && (char === "{" || char === ";" || char === "}")) break;
      j++;
    }
    if (css[j] !== "{") {
      // A statement such as `@layer a, b;` (or a stray `}`, kept verbatim).
      nodes.push({ kind: "text", text: css.slice(i, Math.min(j + 1, css.length)) });
      i = j + 1;
      continue;
    }
    const close = closingBrace(css, j);
    const prelude = css.slice(i, j).trim();
    const body = css.slice(j + 1, close);
    nodes.push(
      groupingAtRules.test(prelude)
        ? { kind: "group", prelude, children: parse(body) }
        : { kind: "rule", prelude, body },
    );
    i = close + 1;
  }
  return nodes;
}

function serialize(nodes: readonly Node[]): string {
  return nodes
    .map((node) =>
      node.kind === "text"
        ? node.text
        : node.kind === "rule"
          ? `${node.prelude}{${node.body}}`
          : `${node.prelude}{${serialize(node.children)}}`,
    )
    .join("");
}

/** Splits on `separator` outside strings, comments, escapes, parentheses and brackets. */
function splitTopLevel(text: string, separator: string): string[] {
  const out: string[] = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < text.length;) {
    const skipped = skipStringOrComment(text, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const char = text[i];
    if (char === "(" || char === "[") depth++;
    else if (char === ")" || char === "]") depth--;
    else if (char === separator && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  out.push(text.slice(start));
  return out.map((part) => part.trim()).filter(Boolean);
}

const declarations = (body: string) => splitTopLevel(body, ";");

const property = (declaration: string) =>
  declaration.slice(0, declaration.indexOf(":")).trim().toLowerCase();

const squash = (text: string) => text.replace(/\s+/g, "");

/**
 * Puts the declaration of a `color-mix()` `@supports` block in place of its fallback in the rule
 * just before it, which the minifier may have merged with other selectors sharing the fallback
 * (`.bg-foreground,.bg-foreground\/50{…}`): the selector then moves to a rule of its own.
 * Returns the rules that replace the previous one, or nothing (changing nothing) unless the block
 * holds one rule whose every declaration has a fallback there.
 */
function replaceFallbacks(previous: Node | undefined, supports: Node[]): Node[] | undefined {
  const [inner, ...rest] = supports;
  if (previous?.kind !== "rule" || previous.prelude.startsWith("@")) return undefined;
  if (inner?.kind !== "rule" || rest.length > 0) return undefined;
  const own = declarations(previous.body);
  for (const declaration of declarations(inner.body)) {
    const name = property(declaration);
    const index = own.findLastIndex((candidate) => property(candidate) === name);
    if (index === -1) return undefined;
    own[index] = declaration;
  }
  const body = own.join(";");
  const selectors = splitTopLevel(previous.prelude, ",");
  const moved = new Set(splitTopLevel(inner.prelude, ",").map(squash));
  const others = selectors.filter((selector) => !moved.has(squash(selector)));
  if (selectors.length - others.length !== moved.size) return undefined;
  if (others.length === 0) return [{ ...previous, body }];
  return [
    { ...previous, prelude: others.join(",") },
    { kind: "rule", prelude: inner.prelude, body },
  ];
}

/** `@layer properties { @supports (…) { *, … { --tw-…: … } } }` and nothing else. */
const isPropertyReset = (node: Node) =>
  node.kind === "group" &&
  squash(node.prelude) === "@layerproperties" &&
  node.children.every(
    (supports) =>
      supports.kind === "group" &&
      supports.prelude.startsWith("@supports") &&
      supports.children.every(
        (rule) =>
          rule.kind === "rule" &&
          rule.prelude.startsWith("*") &&
          declarations(rule.body).every((declaration) => declaration.startsWith("--")),
      ),
  );

function strip(nodes: readonly Node[]): Node[] {
  const out: Node[] = [];
  for (const node of nodes) {
    if (node.kind === "group") {
      const children = strip(node.children);
      const replaced =
        squash(node.prelude) === colorMixSupports
          ? replaceFallbacks(out.at(-1), children)
          : undefined;
      if (replaced) {
        out.splice(-1, 1, ...replaced);
        continue;
      }
      const group = { ...node, children };
      if (isPropertyReset(group)) continue;
      out.push(group);
      continue;
    }
    out.push(node);
  }
  return out;
}

/** Removes Tailwind's legacy-browser polyfills from a built stylesheet. */
export function withoutLegacyPolyfills(css: string): string {
  return serialize(strip(parse(css)));
}

/**
 * Applies {@link withoutLegacyPolyfills} to each stylesheet right after Tailwind generates it, so
 * the final minification can merge the rules the fallbacks kept apart. Goes after `tailwindcss()`.
 */
export function cssWithoutLegacyPolyfills(): Plugin {
  return {
    name: "ace:css-without-legacy-polyfills",
    apply: "build",
    enforce: "pre",
    transform: {
      filter: { id: /\.css(?:\?|$)/ },
      handler(code) {
        const css = withoutLegacyPolyfills(code);
        return css === code ? undefined : { code: css, map: null };
      },
    },
  };
}
