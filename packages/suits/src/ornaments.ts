import type { SuitProblem } from "@ace/protocol/suits";
import { problem } from "./checks.ts";
import {
  attributes,
  dangerous,
  elements,
  paintAttributes,
  transparent,
  voids,
} from "./ornament-allowlist.ts";
import { decodeEntities, tokenizeOrnament, type OrnamentAttribute } from "./ornament-markup.ts";

/*
 * Ornaments (ADR 0150, "Ornaments"): a Suit's static SVG or HTML from `assets/`, rebuilt from an
 * allowlist before any client sees it. Only listed elements and attributes survive; scripts,
 * event handlers, `foreignObject`, animation, links out and `url()` to anything but the Suit's
 * own assets are dropped, each as a problem with its line. Ids are prefixed, so an ornament's
 * gradient never takes an id the app uses. Output is always well formed. Pure.
 */

export const ornamentByteLimit = 64 * 1024;

const refusedCss =
  /expression\s*\(|javascript:|vbscript:|behavior\s*:|-moz-binding|@import|\\|<|>/i;
const cssProperty = /^-?[a-z][a-z-]*$/;
const localId = /^[A-Za-z][\w.-]{0,63}$/;

export interface OrnamentInput {
  /** The asset's path in the Suit, as named in suit.json (`assets/…`). */
  path: string;
  /** Distinguishes the ornament's ids from every other ornament's on the page. */
  index: number;
  bytes: Uint8Array;
  /** The served URL of one of the Suit's assets, or undefined when it has no such file. */
  asset(path: string): string | undefined;
}

export interface SanitisedOrnament {
  markup: string;
  problems: SuitProblem[];
}

/** `value` without whitespace or control characters, which browsers skip inside a URL scheme. */
const withoutSpace = (value: string) =>
  [...value].filter((character) => (character.codePointAt(0) ?? 0) > 0x20).join("");

const escapeText = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttribute = (text: string) => escapeText(text).replace(/"/g, "&quot;");

/** `path` relative to the ornament's own file, as a path inside the Suit, if it stays in assets/. */
function assetPath(from: string, reference: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(reference) || reference.startsWith("/")) return undefined;
  const parts = reference.startsWith("assets/")
    ? reference.split("/")
    : [...from.split("/").slice(0, -1), ...reference.split("/")];
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length <= 1) return undefined;
      out.pop();
    } else out.push(part);
  }
  return out[0] === "assets" && out.length > 1 ? out.join("/") : undefined;
}

export function sanitiseOrnament(input: OrnamentInput): SanitisedOrnament {
  const problems: SuitProblem[] = [];
  const report = (message: string, line: number) =>
    problems.push({ ...problem("ornament", message, input.path), line });
  if (input.bytes.byteLength > ornamentByteLimit) {
    report(
      `${input.path} is ${input.bytes.byteLength} bytes; an ornament may be ${ornamentByteLimit}`,
      1,
    );
    return { markup: "", problems };
  }
  const prefix = `ace-suit-o${input.index}-`;
  const source = new TextDecoder().decode(input.bytes);
  const reported = new Set<string>();
  /** One problem per kind of thing per line, so a big file doesn't drown the list. */
  const once = (key: string, message: string, line: number) => {
    if (reported.has(`${key}\u0000${line}`)) return;
    reported.add(`${key}\u0000${line}`);
    report(message, line);
  };

  /** Every `url()` in `value` as a local id or a served asset; anything else becomes `none`. */
  const cssUrl = (value: string, line: number): string =>
    value.replace(/url\(\s*(["']?)([^"')]*)\1\s*\)/gi, (_, _quote, target: string) => {
      const reference = target.trim();
      if (reference.startsWith("#") && localId.test(reference.slice(1)))
        return `url(#${prefix}${reference.slice(1)})`;
      const path = assetPath(input.path, reference);
      const served = path ? input.asset(path) : undefined;
      if (!served || /["'()\\\s]/.test(served)) {
        once(
          "url",
          `url(${reference}) points outside the Suit's assets; use a file in assets/ or #id`,
          line,
        );
        return "none";
      }
      return `url("${served}")`;
    });

  const style = (value: string, line: number): string | undefined => {
    const kept: string[] = [];
    for (const declaration of value.split(";")) {
      const colon = declaration.indexOf(":");
      if (colon === -1) continue;
      const property = declaration.slice(0, colon).trim().toLowerCase();
      const raw = declaration.slice(colon + 1).trim();
      if (!cssProperty.test(property) || refusedCss.test(raw) || property === "behavior") {
        once("style", `style "${property}: ${raw.slice(0, 40)}" is refused`, line);
        continue;
      }
      kept.push(`${property}:${/url\(/i.test(raw) ? cssUrl(raw, line) : raw}`);
    }
    return kept.length ? kept.join(";") : undefined;
  };

  const attribute = (
    element: string,
    { name, value }: OrnamentAttribute,
    line: number,
  ): [string, string] | undefined => {
    const lower = name.toLowerCase();
    if (lower.startsWith("on")) {
      once("handler", `${element} has an event handler (${name}); ornaments run nothing`, line);
      return undefined;
    }
    const canonical = attributes.get(lower);
    if (!canonical) {
      once(`attr:${lower}`, `${element}'s ${name} attribute is not allowed in an ornament`, line);
      return undefined;
    }
    if (/javascript:|vbscript:|data:/i.test(withoutSpace(value))) {
      once("scheme", `${element}'s ${name} points at a script or data URL`, line);
      return undefined;
    }
    if (lower === "id") return localId.test(value) ? [canonical, `${prefix}${value}`] : undefined;
    if (lower === "style") {
      const kept = style(value, line);
      return kept === undefined ? undefined : [canonical, kept];
    }
    if (lower === "href" || lower === "xlink:href" || lower === "src") {
      if (value.startsWith("#") && localId.test(value.slice(1)) && element !== "img")
        return [canonical, `#${prefix}${value.slice(1)}`];
      const path =
        element === "image" || element === "img" ? assetPath(input.path, value) : undefined;
      const served = path ? input.asset(path) : undefined;
      if (!served) {
        once(
          "href",
          `${element}'s ${name}="${value.slice(0, 60)}" points outside the Suit's assets`,
          line,
        );
        return undefined;
      }
      return [canonical, served];
    }
    if (paintAttributes.has(lower) && /url\(/i.test(value)) return [canonical, cssUrl(value, line)];
    return [canonical, value];
  };

  let out = "";
  const open: string[] = [];
  /** While > 0, inside a dropped element: nothing is written. */
  let dropping = 0;
  for (const token of tokenizeOrnament(source)) {
    if (token.kind === "skip") continue;
    if (token.kind === "text") {
      if (!dropping) out += escapeText(decodeEntities(token.text));
      continue;
    }
    const lower = token.name.toLowerCase();
    if (token.kind === "close") {
      if (dropping) {
        dropping -= 1;
        continue;
      }
      const at = open.lastIndexOf(lower);
      if (at === -1) continue;
      while (open.length > at) out += `</${elements.get(open.pop() ?? "") ?? ""}>`;
      continue;
    }
    const isVoid = token.selfClosing || voids.has(lower);
    if (dropping) {
      if (!isVoid) dropping += 1;
      continue;
    }
    if (transparent.has(lower)) continue;
    const canonical = elements.get(lower);
    if (!canonical) {
      once(
        `element:${lower}`,
        dangerous.has(lower)
          ? `<${token.name}> is refused in an ornament (no scripts, styles, embeds, links or animation)`
          : `<${token.name}> is not an element an ornament may use`,
        token.line,
      );
      if (!isVoid) dropping = 1;
      continue;
    }
    let tag = `<${canonical}`;
    for (const given of token.attributes) {
      const kept = attribute(canonical, given, token.line);
      if (kept) tag += ` ${kept[0]}="${escapeAttribute(kept[1])}"`;
    }
    if (isVoid) {
      // HTML ignores a "/>" on a non-void element, so it is closed explicitly.
      out += voids.has(lower) ? `${tag}>` : `${tag}></${canonical}>`;
      continue;
    }
    out += `${tag}>`;
    open.push(lower);
  }
  while (open.length) out += `</${elements.get(open.pop() ?? "") ?? ""}>`;
  return { markup: out.trim(), problems };
}
