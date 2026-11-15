import { walk, type CssNode, type Declaration } from "css-tree";

/*
 * What a declaration in a Suit's CSS may say (ADR 0150, "suit.css"): anything visual, with every
 * url() pointing into the Suit's own assets/ (rewritten to their served URLs), and nothing that
 * runs code, reads hidden data or shows other parts of the page. Pure.
 */

export interface ValueContext {
  /** Asset paths the Suit holds (`assets/...`). */
  assets: ReadonlySet<string>;
  /** The served URL of an asset path. */
  url(path: string): string;
  /** The Suit's own keyframes, by the name it wrote → the scoped name. */
  keyframes: ReadonlyMap<string, string>;
}

/** Properties that bind behaviour or run code in some engine. */
const bannedProperties = new Set(["behavior", "-ms-behavior", "-moz-binding"]);
/** Functions that run code, read attributes, or paint other elements. */
const bannedFunctions = new Set(["expression", "attr", "src", "element", "-moz-element", "paint"]);
/** An escape in a name hides what it is (`\75 rl(` is `url(`), so names are written plainly. */
const escaped = (name: string) => name.includes("\\");
/** Small raster images only: an SVG can carry its own references, so it is bundled instead. */
const dataImage = /^data:image\/(png|gif|jpeg|webp|avif);base64,[A-Za-z0-9+/]+={0,2}$/;
export const dataImageBytes = 8 * 1024;

const animationProperties = new Set(["animation", "animation-name"]);

/** An asset path as written (`assets/a.png` or `./assets/a.png`), or undefined if it isn't one. */
function assetPath(value: string): string | undefined {
  const path = value.startsWith("./") ? value.slice(2) : value;
  if (!/^assets\/[A-Za-z0-9._/-]+$/.test(path)) return undefined;
  if (path.split("/").some((part) => part === ".." || part === "." || part === ""))
    return undefined;
  return path;
}

/** Why `url` can't be used, or undefined after rewriting it in place. */
function checkUrl(
  node: Extract<CssNode, { type: "Url" }>,
  context: ValueContext,
): string | undefined {
  const value = node.value.trim();
  if (value.startsWith("data:")) {
    if (!dataImage.test(value))
      return "only small base64 PNG, GIF, JPEG, WebP or AVIF data: images are allowed; bundle anything else in assets/";
    if (value.length > dataImageBytes)
      return `a data: image is over ${dataImageBytes} bytes; bundle it in assets/`;
    return undefined;
  }
  const path = assetPath(value);
  if (!path) return `url(${value}) points outside the Suit; use a file in its assets/`;
  if (!context.assets.has(path)) return `${path} is not in the Suit's assets/`;
  node.value = context.url(path);
  return undefined;
}

/**
 * Checks `declaration`'s value and rewrites it in place: asset urls to served URLs, the Suit's
 * keyframe names to their scoped names. Returns why it can't be used, if it can't.
 */
export function checkDeclaration(
  declaration: Declaration,
  context: ValueContext,
): string | undefined {
  const property = declaration.property.toLowerCase();
  if (escaped(property)) return "write property names without escapes";
  if (bannedProperties.has(property)) return `${property} is not allowed`;
  if (declaration.important)
    return "!important is not allowed; a Suit's rules already win over ace's";
  if (property.startsWith("--") && !property.startsWith("--suit-"))
    return `${property}: a Suit's custom properties start with --suit-; ace's own tokens come from suit.json`;
  const renames = animationProperties.has(property);
  let reason: string | undefined;
  walk(declaration.value, (node) => {
    if (reason) return;
    switch (node.type) {
      case "Url":
        reason = checkUrl(node, context);
        break;
      case "Function": {
        const name = node.name.toLowerCase();
        if (escaped(name)) reason = "write function names without escapes";
        // url() with a quoted string parses as a Url node; a function named url is a disguise.
        else if (name === "url") reason = "url() must point at a file in the Suit's assets/";
        else if (bannedFunctions.has(name)) reason = `${name}() is not allowed`;
        else if ((name === "image-set" || name === "-webkit-image-set") && hasString(node))
          reason = `${name}() takes url() images, not strings`;
        break;
      }
      case "Raw":
        if (/[\\(){};@]|url/i.test(node.value)) reason = "this value doesn't parse as CSS";
        break;
      case "Identifier":
        if (escaped(node.name)) {
          reason = "write names without escapes";
          break;
        }
        if (renames) {
          const scoped = context.keyframes.get(node.name);
          if (scoped) node.name = scoped;
        }
        break;
      default:
        break;
    }
  });
  return reason;
}

function hasString(node: CssNode): boolean {
  let found = false;
  walk(node, (child) => {
    if (child.type === "String") found = true;
  });
  return found;
}

export const isAnimation = (property: string) => property.toLowerCase().startsWith("animation");

/**
 * What a rule whose subject is a protected part (`protectedSuitParts`) may still set: its frame
 * (padding, corners, border) and its typeface. Size, spacing that could push it away, visibility,
 * colour, motion and paint stay ace's.
 */
const framing = [
  /^padding(-|$)/,
  /^border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-(width|style|color))?$/,
  /^border(-(top|bottom|start|end)(-(left|right|start|end))?)?-radius$/,
  /^font-(family|weight|style|stretch)$/,
  /^text-transform$/,
  /^--suit-/,
];
export const framesOnly = (property: string) =>
  framing.some((pattern) => pattern.test(property.toLowerCase()));

/** A `@font-face` declaration: its sources must be bundled font files. */
const fontFile = /\.(woff2|woff|ttf|otf)$/i;
const fontFaceProperties = new Set([
  "font-family",
  "src",
  "font-weight",
  "font-style",
  "font-display",
  "font-stretch",
  "unicode-range",
  "font-feature-settings",
  "font-variation-settings",
  "ascent-override",
  "descent-override",
  "line-gap-override",
  "size-adjust",
]);

export function checkFontFaceDeclaration(
  declaration: Declaration,
  context: ValueContext,
): string | undefined {
  const property = declaration.property.toLowerCase();
  if (!fontFaceProperties.has(property)) return `${property} doesn't belong in @font-face`;
  if (property === "src") {
    let reason: string | undefined;
    walk(declaration.value, (node) => {
      if (reason) return;
      if (node.type === "Url") {
        const path = assetPath(node.value.trim());
        if (!path || !fontFile.test(path))
          reason = "@font-face loads only .woff2, .woff, .ttf or .otf files from assets/";
      }
    });
    if (reason) return reason;
  }
  return checkDeclaration(declaration, context);
}
