import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { appArt, appMonogram } from "./app-icons.ts";

const root = join(import.meta.dirname, "..", "..", "..");
const catalogue = (
  JSON.parse(readFileSync(join(root, "spade", "config", "connectors.json"), "utf8")) as {
    connectors: { id: string; name: string }[];
  }
).connectors;
const licences = readFileSync(join(import.meta.dirname, "app-art", "LICENCES.md"), "utf8");

/** The LICENCES.md table, by app id: its mark, source and licence cells. */
const rows = new Map(
  licences
    .split("\n")
    .filter((line) => line.startsWith("| ") && line.includes("`"))
    .map((line) => {
      const cells = line.split(" | ").map((cell) => cell.trim());
      return [/`([^`]+)`/.exec(cells[1] ?? "")?.[1] ?? "", cells] as const;
    }),
);

it("every catalogue app has a licence row naming where its mark came from", () => {
  for (const entry of catalogue) {
    const row = rows.get(entry.id);
    expect(row, entry.id).toBeDefined();
    const [, , mark = "", source = "", licence = ""] = row ?? [];
    if (entry.id in appArt) {
      expect(source, entry.id).toMatch(/https:\/\//);
      expect(licence, entry.id).not.toBe("");
    } else {
      // No mark yet: the row says so and where the owner can get one.
      expect(mark, entry.id).toMatch(/^Monogram/);
      expect(source, entry.id).toMatch(/^To add:/);
    }
  }
});

it("every bundled mark belongs to a catalogue app and draws something", async () => {
  const ids = new Set(catalogue.map((entry) => entry.id));
  for (const [id, load] of Object.entries(appArt)) {
    expect(ids.has(id), id).toBe(true);
    const art = await load();
    expect(art.viewBox.split(" "), id).toHaveLength(4);
    expect(art.mono.length, id).toBeGreaterThan(0);
    for (const path of [...art.mono, ...(art.color ?? [])]) expect(path.d, id).not.toBe("");
  }
});

it("most catalogue apps show their own mark rather than a letter", () => {
  const marked = catalogue.filter((entry) => entry.id in appArt).length;
  expect(marked / catalogue.length).toBeGreaterThan(0.75);
});

it("an app with no mark shows the first letter or digit of its name", () => {
  expect(appMonogram("monday.com")).toBe("M");
  expect(appMonogram("  ätlas")).toBe("Ä");
  expect(appMonogram("127.0.0.1")).toBe("1");
  expect(appMonogram("(beta) tools")).toBe("B");
  expect(appMonogram("")).toBe("?");
});
