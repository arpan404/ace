import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { seedRoot, templatesPath } from "../src/seed/folders.ts";
import { listingOf, recipeOf, TemplatesFile } from "../src/seed/recipes.ts";

/*
 * Writes the seed's bot recipes from Spade's built-in templates: one `seed/spade-bot/<id>/`
 * folder each, with `bot.json` and `market.json`. Suits and skills in the seed are kept by hand.
 * Run after changing spade/config/templates.json: `bun run build-seed` in apps/market.
 */

const templates = TemplatesFile.parse(JSON.parse(await readFile(templatesPath, "utf8")));
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

for (const template of templates.templates) {
  const folder = join(seedRoot, "spade-bot", template.id);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "bot.json"), json(recipeOf(template)));
  await writeFile(join(folder, "market.json"), json(listingOf(template)));
}
// In the repository's own format, so `bun run fmt:check` passes on what this wrote.
execFileSync("bunx", ["oxfmt", join(seedRoot, "spade-bot")], { stdio: "inherit" });
console.log(`Wrote ${templates.templates.length} recipes to ${join(seedRoot, "spade-bot")}`);
