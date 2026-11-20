import { readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { writeArchive } from "@ace/marketplace";
import { checkArchive, checkFiles } from "@ace/marketplace/checks";
import { scanEntry } from "@ace/marketplace/scan";
import { readSeed, templatesRoot } from "./folders.ts";

const seeds = await readSeed();
const templates = (await readdir(templatesRoot, { withFileTypes: true }))
  .filter((item) => item.isDirectory())
  .map((item) => item.name);
const names = (type: string) => seeds.filter((seed) => seed.type === type).map((seed) => seed.name);

describe("the market's seed", () => {
  it("holds ace's Suits, a recipe per Spade template and a starter set of skills", () => {
    expect(names("suit")).toEqual(["mizzle", "tarn"]);
    expect(names("spade-bot")).toEqual(templates.toSorted());
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

  it.each(seeds.map((seed) => [`${seed.type}/${seed.name}`, seed] as const))(
    "%s is not blocked by the full scan",
    (_key, seed) => {
      const checked = checkFiles(seed.type, seed.name, seed.files);
      const report = scanEntry({
        type: seed.type,
        name: seed.name,
        files: seed.files,
        listing: checked.listing,
        inspection: checked.inspection,
        context: { entries: [], verified: [] },
      });
      const blocks = report.findings.filter((finding) => finding.level === "block");
      expect(blocks, blocks.map((f) => `${f.rule}: ${f.message}`).join("; ")).toEqual([]);
      expect(report.verdict).not.toBe("block");
    },
  );

  it("each bot is the agent package Spade ships as that template, so the two never drift", () => {
    for (const template of templates) {
      const seed = seeds.find((entry) => entry.type === "spade-bot" && entry.name === template);
      const paths = seed?.files.map((file) => file.path).toSorted();
      expect(paths, template).toContain("bot.json");
      expect(paths, template).toContain("market.json");
      const bot = seed?.files.find((file) => file.path === "bot.json");
      expect(JSON.parse(new TextDecoder().decode(bot?.content)).version, template).toBe(3);
    }
  });
});
