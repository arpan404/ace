import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { writeArchive } from "@ace/marketplace";
import { checkArchive } from "@ace/marketplace/checks";
import { readSeed, templatesPath } from "./folders.ts";
import { recipeOf, TemplatesFile } from "./recipes.ts";

const seeds = await readSeed();
const { templates } = TemplatesFile.parse(JSON.parse(await readFile(templatesPath, "utf8")));
const names = (type: string) => seeds.filter((seed) => seed.type === type).map((seed) => seed.name);

describe("the market's seed", () => {
  it("holds ace's Suits, a recipe per Spade template and a starter set of skills", () => {
    expect(names("suit")).toEqual(["mizzle", "tarn"]);
    expect(names("spade-bot")).toEqual(templates.map((template) => template.id).toSorted());
    expect(names("spade-skill").length).toBeGreaterThanOrEqual(4);
  });

  it.each(seeds.map((seed) => [`${seed.type}/${seed.name}`, seed] as const))(
    "%s passes the market's checks",
    (_key, seed) => {
      const checked = checkArchive(seed.type, seed.name, writeArchive(seed.files));
      expect(checked.problems).toEqual([]);
      expect(checked.listing.line).not.toBe("");
    },
  );

  it("each recipe is its template as written out, so the two never drift", () => {
    for (const template of templates) {
      const seed = seeds.find((entry) => entry.type === "spade-bot" && entry.name === template.id);
      const bot = seed?.files.find((file) => file.path === "bot.json");
      expect(JSON.parse(new TextDecoder().decode(bot?.content)), template.id).toEqual(
        recipeOf(template),
      );
    }
  });
});
