import { brandArt, providerBrands, type BrandPath } from "@ace/ui-core/provider-icons";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Writes each built-in provider's brand mark into `Resources/Assets.xcassets/ProviderMarks` as
 * a vector SVG image set named `provider-<kind>` (`provider-codex` carries the OpenAI mark), from
 * the shared path data and provider-to-brand table in `@ace/ui-core/provider-icons`, so Swift
 * looks a mark up by the row's provider and never maps brands itself:
 *
 *   bun scripts/generate-provider-marks.ts
 *
 * A mark with its own colours keeps them (`original`); a single-colour mark is a template, so
 * the app tints it like text. The outputs are committed; rerun after the shared marks change.
 */
const folder = join(import.meta.dirname, "..", "Resources", "Assets.xcassets", "ProviderMarks");

const attribute = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
const path = (part: BrandPath, colour: string) =>
  `<path d="${attribute(part.d)}" fill="${attribute(part.fill ?? colour)}"` +
  (part.fillRule ? ` fill-rule="${part.fillRule}"` : "") +
  (part.clipRule ? ` clip-rule="${part.clipRule}"` : "") +
  (part.opacity === undefined ? "" : ` opacity="${part.opacity}"`) +
  "/>";

await rm(folder, { recursive: true, force: true });
await mkdir(folder, { recursive: true });
await writeFile(
  join(folder, "Contents.json"),
  `${JSON.stringify({ info: { author: "xcode", version: 1 } }, null, 2)}\n`,
);
const kinds = Object.entries(providerBrands).toSorted(([a], [b]) => a.localeCompare(b));
let written = 0;
for (const [kind, brand] of kinds) {
  // A provider with no mark (ACP) has no image; the app draws its neutral agent glyph.
  if (brand === undefined) continue;
  const art = await brandArt[brand]();
  // Gradients need a renderer of their own; such marks fall back to their single-colour form.
  const coloured = art.color?.every((part) => part.gradient === undefined) ? art.color : undefined;
  const parts = coloured ?? art.mono;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${art.viewBox}" width="24" height="24">` +
    parts.map((part) => path(part, "#000000")).join("") +
    "</svg>\n";
  const set = join(folder, `provider-${kind}.imageset`);
  await mkdir(set, { recursive: true });
  await writeFile(join(set, `${brand}.svg`), svg);
  const contents = {
    images: [{ filename: `${brand}.svg`, idiom: "universal" }],
    info: { author: "xcode", version: 1 },
    properties: {
      "preserves-vector-representation": true,
      "template-rendering-intent": coloured ? "original" : "template",
    },
  };
  await writeFile(join(set, "Contents.json"), `${JSON.stringify(contents, null, 2)}\n`);
  written++;
}
console.log(`Wrote ${written} provider marks to ${folder}`);
