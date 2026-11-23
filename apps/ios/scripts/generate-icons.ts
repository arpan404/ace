import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as aceIcons from "@ace/icons";
import type { Icon } from "@ace/icons";
import { machineIconGlyphs, projectGlyphIcons } from "@ace/ui-core";
import { aceGlyphSvgs } from "./generate-glyphs.ts";
import { assetSvg, filledAssetSvg, spadeTabSvg, type AssetWeight } from "./icon-svg.ts";
import {
  spadeEggPath,
  spadeEye,
  spadeEyes,
  spadePupilAt,
  spadePupilForSize,
  spadeRingForSize,
  spadeTiltDeg,
  type SpadePoint,
} from "@ace/ui-core/spade";
import {
  barIconSize,
  barIcons,
  drawnAs,
  extra,
  filledIcons,
  fromSymbols,
  sidebarFilledIcons,
  tabIconSize,
  tabIcons,
} from "./icon-names.ts";

/**
 * Writes the iPhone's icons into `Shared/Icons.xcassets` as vector template images, and the
 * Swift names the app draws them by into `Shared/AceIcon.generated.swift`:
 *
 *   bun scripts/generate-icons.ts
 *
 * Every icon is ace's own, from `@ace/icons` (ADR 0156), the set the web draws. Each name is
 * written in regular (`icon-<name>`) and bold (`icon-<name>-bold`), and those in `filledIcons`
 * filled (`icon-<name>-fill`). A name is the `@ace/icons`
 * glyph of the same name, else the glyph `drawnAs` gives it. The tab bar's glyphs (`tabIcons`) are
 * also written at tab size (`tab-<name>`), with filled variants for the iPad sidebar. Navigation
 * bar glyphs (`barIcons`) are written at bar size (`bar-<name>`). Add an icon by adding its name to
 * `extra`, or a row to `fromSymbols` when it replaces an SF Symbol. Every curated project glyph and machine mark (`@ace/ui-core`) is included, so
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

/** The `@ace/icons` component that draws `glyph`, by its exported name. */
const icons: Record<string, unknown> = aceIcons;
function aceIcon(glyph: string): Icon | undefined {
  const icon = icons[`${pascal(glyph)}Icon`];
  return typeof icon === "function" ? (icon as Icon) : undefined;
}

const root = join(import.meta.dirname, "..");
const folder = join(root, "Shared", "Icons.xcassets");
const names = [
  ...new Set([
    ...Object.values(fromSymbols),
    ...extra,
    ...filledIcons,
    ...Object.values(projectGlyphIcons),
    ...Object.values(machineIconGlyphs),
  ]),
].toSorted();
/** ace's own glyphs (`generate-glyphs.ts`), named beside the set's and drawn the same way. */
const aceNames = Object.keys(aceGlyphSvgs);

// Every name resolves before anything is written, so a missing drawing leaves the assets as they were.
const sources = names.map((name) => {
  const { glyph, turn = 0 } = drawnAs[name] ?? { glyph: name };
  const icon = aceIcon(glyph);
  if (!icon) throw new Error(`@ace/icons has no ${glyph} for ${name}: add a row to drawnAs.`);
  return { name, icon, turn };
});

await rm(folder, { recursive: true, force: true });
await mkdir(folder, { recursive: true });
await writeFile(
  join(folder, "Contents.json"),
  `${JSON.stringify({ info: { author: "xcode", version: 1 } }, null, 2)}\n`,
);
const writeAsset = async (
  asset: string,
  svg: string,
  rendering: "template" | "original" = "template",
) => {
  const set = join(folder, `${asset}.imageset`);
  await mkdir(set, { recursive: true });
  await writeFile(join(set, `${asset}.svg`), svg);
  const contents = {
    images: [{ filename: `${asset}.svg`, idiom: "universal" }],
    info: { author: "xcode", version: 1 },
    properties: {
      "preserves-vector-representation": true,
      "template-rendering-intent": rendering,
    },
  };
  await writeFile(join(set, "Contents.json"), `${JSON.stringify(contents, null, 2)}\n`);
};
const assetName = (name: string, weight: AssetWeight) =>
  weight === "regular" ? `icon-${name}` : `icon-${name}-${weight}`;

// One drawing for both weights: ace's glyphs carry their own stroke.
for (const [name, svg] of Object.entries(aceGlyphSvgs)) {
  await writeAsset(assetName(name, "regular"), svg);
  await writeAsset(assetName(name, "bold"), svg);
}
for (const { name, icon, turn } of sources) {
  for (const weight of ["regular", "bold"] as const)
    await writeAsset(assetName(name, weight), assetSvg(icon, weight, turn));
}
for (const name of filledIcons) {
  const source = sources.find((entry) => entry.name === name);
  if (!source) throw new Error(`${name} is a filled icon but not one of the icons.`);
  await writeAsset(assetName(name, "fill"), filledAssetSvg(source.icon, source.turn));
}
// The tab bar's glyphs at its size, each named in `names` above.
for (const name of tabIcons) {
  const source = sources.find((entry) => entry.name === name);
  if (!source) throw new Error(`${name} is a tab icon but not one of the icons: add it to extra.`);
  await writeAsset(`tab-${name}`, assetSvg(source.icon, "regular", source.turn, tabIconSize));
  if (sidebarFilledIcons.has(name))
    await writeAsset(`tab-${name}-fill`, assetSvg(source.icon, "fill", source.turn, tabIconSize));
}
// Spade's face for the tab bar, in colour as the desktop rail draws it (`SpadeMark`).
{
  const { pupil, pad } = spadePupilForSize(tabIconSize);
  const face = {
    eyes: spadeEyes,
    eye: spadeEye,
    pupil,
    pupilAt: (eye: SpadePoint) => spadePupilAt(eye, pupil, pad),
    ring: spadeRingForSize(tabIconSize),
    tilt: spadeTiltDeg,
    egg: spadeEggPath,
  };
  await writeAsset("tab-spade", spadeTabSvg(face, tabIconSize), "original");
  // fx-spade-look translates the resting pupils by these offsets in the 24-unit box.
  const rest = spadePupilAt({ x: 0, y: 0 }, pupil, pad);
  const glances = [
    { dx: -1.1, dy: -0.5 },
    { dx: 1.1, dy: -0.6 },
  ];
  for (const [index, glance] of glances.entries()) {
    const look = { dx: rest.x + glance.dx, dy: rest.y + glance.dy };
    const frame = { ...face, pupilAt: (eye: SpadePoint) => spadePupilAt(eye, pupil, pad, look) };
    await writeAsset(`tab-spade-look-${index + 1}`, spadeTabSvg(frame, tabIconSize), "original");
  }
  await writeAsset("tab-spade-blink", spadeTabSvg(face, tabIconSize, true), "original");
}
// The navigation bar's button glyphs at a bar symbol's size.
for (const { name, weight } of barIcons) {
  const source = sources.find((entry) => entry.name === name);
  if (!source) throw new Error(`${name} is a bar icon but not one of the icons: add it to extra.`);
  const asset = weight === "bold" ? `bar-${name}-bold` : `bar-${name}`;
  await writeAsset(asset, assetSvg(source.icon, weight, source.turn, barIconSize));
}
const swift = [
  "// Generated by scripts/generate-icons.ts from @ace/icons. Do not edit.",
  "",
  "extension AceIcon {",
  "    /// Every icon in `Icons.xcassets`, drawn as `icon-<raw value>`.",
  "    enum Name: String, CaseIterable, Sendable {",
  ...[...names, ...aceNames].map((name) => `        case ${swiftCase(name)} = "${name}"`),
  "",
  "        /// The icons also drawn filled, as `icon-<raw value>-fill`.",
  "        static let filled: Set<Name> = [",
  ...filledIcons.map((name) => `            .${swiftCase(name)},`),
  "        ]",
  "    }",
  "}",
  "",
].join("\n");
await writeFile(join(root, "Shared", "AceIcon.generated.swift"), swift);
console.log(
  `Wrote ${names.length} icons from @ace/icons and ${aceNames.length} ace glyphs to ${folder}`,
);
