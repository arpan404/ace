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
});
