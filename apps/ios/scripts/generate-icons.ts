import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as aceIcons from "@ace/icons";
import type { Icon } from "@ace/icons";
import { machineIconGlyphs, projectGlyphIcons } from "@ace/ui-core";
import { aceGlyphSvgs } from "./generate-glyphs.ts";
import { assetSvg } from "./icon-svg.ts";
import { drawnAs, extra, fromSymbols, phosphorOnly } from "./icon-names.ts";

/**
 * Writes the iPhone's icons into `Shared/Icons.xcassets` as vector template images, and the
 * Swift names the app draws them by into `Shared/AceIcon.generated.swift`:
 *
 *   bun scripts/generate-icons.ts
 *
 * Every icon is ace's own, from `@ace/icons` (ADR 0156), the set the web draws. Each name is
 * written in regular (`icon-<name>`) and bold (`icon-<name>-bold`). A name is the `@ace/icons`
 * glyph of the same name, else the glyph `drawnAs` gives it. The few names the set has no
 * drawing for yet are listed in `phosphorOnly` and still come from `@phosphor-icons/react`
 * (MIT). Add an icon by adding its name to `extra`, or a row to `fromSymbols` when it replaces
 * an SF Symbol. Every curated project glyph and machine mark (`@ace/ui-core`) is included, so
 * the bridge can name them. The outputs are committed.
 */

const pascal = (name: string) =>
  name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
const camel = (name: string) => {
  const value = pascal(name);
  return value.charAt(0).toLowerCase() + value.slice(1);
};
const swiftKeywords = new Set(["repeat", "function", "subtract", "return", "default", "case"]);
const swiftCase = (name: string) =>
  swiftKeywords.has(camel(name)) ? `\`${camel(name)}\`` : camel(name);
const attribute = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

/** The `@ace/icons` component that draws `glyph`, by its exported name. */
const icons: Record<string, unknown> = aceIcons;
function aceIcon(glyph: string): Icon | undefined {
  const icon = icons[`${pascal(glyph)}Icon`];
  return typeof icon === "function" ? (icon as Icon) : undefined;
}

interface Element {
  t: string;
  p: Record<string, string> | null;
  c: Element[];
}
type Weights = Map<string, Element>;

/**
 * A Phosphor definition module maps each weight to a React fragment of `<path>`s. It is read
 * with a stand-in `createElement` that records the tree instead of rendering it.
 */
async function weightsOf(defs: string, name: string): Promise<Weights> {
  const source = await readFile(join(defs, `${pascal(name)}.es.js`), "utf8");
  const body = source
    .replace(
      /^import \* as (\w+) from "react";/m,
      "const $1 = { Fragment: 'fragment', createElement: (t, p, ...c) => ({ t, p, c }) };",
    )
    .replace(/export\s*\{\s*(\w+) as default\s*\};?\s*$/m, "return $1;");
  // oxlint-disable-next-line no-new-func -- evaluates the installed package's own definition
  const weights: unknown = new Function(body)();
  if (!(weights instanceof Map)) throw new Error(`Unexpected Phosphor definition for ${name}.`);
  return weights as Weights;
}

function phosphorSvg(fragment: Element): string {
  const paths: string[] = [];
  const visit = (node: Element) => {
    if (node.t === "path" && node.p?.d) {
      const opacity = node.p.opacity === undefined ? "" : ` opacity="${attribute(node.p.opacity)}"`;
      paths.push(`<path d="${attribute(node.p.d)}"${opacity}/>`);
    } else if (node.t !== "fragment") throw new Error(`Unexpected <${node.t}> in a Phosphor icon.`);
    for (const child of node.c) if (child && typeof child === "object") visit(child);
  };
  visit(fragment);
  // 20pt intrinsic size: what a menu or swipe action draws when it can't size the image itself.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="20" height="20" fill="#000000">${paths.join("")}</svg>\n`;
}

const root = join(import.meta.dirname, "..");
const folder = join(root, "Shared", "Icons.xcassets");
const names = [
  ...new Set([
    ...Object.values(fromSymbols),
    ...extra,
    ...Object.values(projectGlyphIcons),
    ...Object.values(machineIconGlyphs),
  ]),
].toSorted();
/** ace's own glyphs (`generate-glyphs.ts`), named beside the set's and drawn the same way. */
const aceNames = Object.keys(aceGlyphSvgs);

// Every name resolves before anything is written, so a missing drawing leaves the assets as they were.
const sources = names.map((name) => {
  if (phosphorOnly.has(name)) {
    if (aceIcon(name)) throw new Error(`@ace/icons now draws ${name}: drop it from phosphorOnly.`);
    return { name, icon: undefined, turn: 0 };
  }
  const { glyph, turn = 0 } = drawnAs[name] ?? { glyph: name };
  const icon = aceIcon(glyph);
  if (!icon)
    throw new Error(
      `@ace/icons has no ${glyph} for ${name}: add a row to drawnAs or phosphorOnly.`,
    );
  return { name, icon, turn };
});

await rm(folder, { recursive: true, force: true });
await mkdir(folder, { recursive: true });
await writeFile(
  join(folder, "Contents.json"),
  `${JSON.stringify({ info: { author: "xcode", version: 1 } }, null, 2)}\n`,
);
const writeAsset = async (asset: string, svg: string) => {
  const set = join(folder, `${asset}.imageset`);
  await mkdir(set, { recursive: true });
  await writeFile(join(set, `${asset}.svg`), svg);
  const contents = {
    images: [{ filename: `${asset}.svg`, idiom: "universal" }],
    info: { author: "xcode", version: 1 },
    properties: {
      "preserves-vector-representation": true,
      "template-rendering-intent": "template",
    },
  };
  await writeFile(join(set, "Contents.json"), `${JSON.stringify(contents, null, 2)}\n`);
};
const assetName = (name: string, weight: "regular" | "bold") =>
  weight === "regular" ? `icon-${name}` : `icon-${name}-bold`;

// One drawing for both weights: ace's glyphs carry their own stroke.
for (const [name, svg] of Object.entries(aceGlyphSvgs)) {
  await writeAsset(assetName(name, "regular"), svg);
  await writeAsset(assetName(name, "bold"), svg);
}
for (const { name, icon, turn } of sources) {
  if (!icon) continue;
  for (const weight of ["regular", "bold"] as const)
    await writeAsset(assetName(name, weight), assetSvg(icon, weight, turn));
}
const phosphor = names.filter((name) => phosphorOnly.has(name));
const defs = join(dirname(fileURLToPath(import.meta.resolve("@phosphor-icons/react"))), "defs");
for (const name of phosphor) {
  const weights = await weightsOf(defs, name);
  for (const weight of ["regular", "bold"] as const) {
    const fragment = weights.get(weight);
    if (!fragment) throw new Error(`Phosphor has no ${weight} ${name}.`);
    await writeAsset(assetName(name, weight), phosphorSvg(fragment));
  }
}

const swift = [
  "// Generated by scripts/generate-icons.ts from @ace/icons. Do not edit.",
  "",
  "extension AceIcon {",
  "    /// Every icon in `Icons.xcassets`, drawn as `icon-<raw value>`.",
  "    enum Name: String, CaseIterable, Sendable {",
  ...[...names, ...aceNames].map((name) => `        case ${swiftCase(name)} = "${name}"`),
  "    }",
  "}",
  "",
].join("\n");
await writeFile(join(root, "Shared", "AceIcon.generated.swift"), swift);
await writeFile(
  join(root, "Resources", "Licences", "phosphor-icons-license.txt"),
  await readFile(join(defs, "..", "..", "LICENSE"), "utf8"),
);
console.log(
  `Wrote ${names.length - phosphor.length} icons from @ace/icons, ${phosphor.length} from Phosphor ` +
    `(${phosphor.join(", ")}) and ${aceNames.length} ace glyphs to ${folder}`,
);
