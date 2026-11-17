import { describe, expect, it } from "vitest";
import { search, type Searchable } from "./search.ts";

const item = (name: string, extra: Partial<Searchable> = {}): Searchable => ({
  source: "market",
  type: "spade-skill",
  name,
  title: name,
  line: "",
  keywords: [],
  categories: [],
  reviewed: false,
  downloads: 0,
  ...extra,
});
const names = (items: Searchable[]) => items.map((entry) => entry.name);
const popular = (tier: Searchable["tier"], downloads: number, name: string) =>
  item(name, { tier, downloads, reviewed: true });

describe("marketplace search", () => {
  it("ranks a name match above a title match above a line match", () => {
    const items = [
      item("notes", { line: "Keeps your calendar tidy" }),
      item("planner", { title: "Calendar planner" }),
      item("calendar"),
    ];
    expect(names(search(items, { query: "calendar" }))).toEqual(["calendar", "planner", "notes"]);
  });

  it("counts a rarer word for more", () => {
    const items = [
      item("a", { line: "mail tool" }),
      item("b", { line: "mail tool" }),
      item("c", { line: "mail invoices" }),
      item("d", { line: "mail tool" }),
    ];
    expect(search(items, { query: "mail invoices" })[0]?.name).toBe("c");
  });

  it("forgives a typo", () => {
    expect(names(search([item("calendar"), item("weather")], { query: "calender" }))).toEqual([
      "calendar",
    ]);
  });

  it("matches a word still being typed", () => {
    expect(names(search([item("calendar"), item("weather")], { query: "cale" }))).toEqual([
      "calendar",
    ]);
  });

  it("needs every word of the query to match", () => {
    expect(names(search([item("mail-sort"), item("mail-draft")], { query: "mail draft" }))).toEqual(
      ["mail-draft"],
    );
  });

  it("narrows by type and source", () => {
    const items = [item("x"), item("y", { type: "suit" }), item("z", { source: "git:abc" })];
    expect(names(search(items, { query: "", type: "spade-skill", source: "market" }))).toEqual([
      "x",
    ]);
  });

  it("lists only reviewed entries under a category", () => {
    const items = [
      item("x", { categories: ["mail"] }),
      item("y", { categories: ["mail"], reviewed: true }),
    ];
    expect(names(search(items, { query: "", category: "mail" }))).toEqual(["y"]);
  });

  it("orders an empty query reviewed first, then by downloads", () => {
    const items = [
      item("a", { downloads: 9 }),
      item("b", { reviewed: true }),
      item("c", { downloads: 50 }),
    ];
    expect(names(search(items, { query: "" }))).toEqual(["b", "c", "a"]);
  });

  describe("publisher tiers (ADR 0174 §15)", () => {
    it("rank official above verified above the rest among equals", () => {
      const items = [
        popular(undefined, 500, "c-other"),
        popular("verified", 500, "b-verified"),
        popular("official", 500, "a-official"),
      ];
      expect(names(search(items, { query: "" }))).toEqual(["a-official", "b-verified", "c-other"]);
      const matched = [
        item("mail-other", { line: "mail" }),
        item("mail-verified", { line: "mail", tier: "verified" }),
        item("mail-official", { line: "mail", tier: "official" }),
      ];
      expect(names(search(matched, { query: "mail" }))).toEqual([
        "mail-official",
        "mail-verified",
        "mail-other",
      ]);
    });

    it("never lift an official entry with very few downloads over a much more popular one", () => {
      const items = [popular("official", 40, "small-official"), popular(undefined, 4000, "big")];
      expect(names(search(items, { query: "" }))).toEqual(["big", "small-official"]);
      const verified = [popular("verified", 300, "small-verified"), popular(undefined, 900, "big")];
      expect(names(search(verified, { query: "" }))).toEqual(["big", "small-verified"]);
    });

    it("never lift a verified entry that matches worse over one that matches better", () => {
      const items = [
        item("weekly-digest", { tier: "official", line: "calendar" }),
        item("calendar"),
      ];
      expect(names(search(items, { query: "calendar" }))).toEqual(["calendar", "weekly-digest"]);
    });
  });
});
