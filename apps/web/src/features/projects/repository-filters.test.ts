import { expect, test } from "vitest";
import { activeFilters, defaultFilters, onlyTextChanged } from "./repository-filters.ts";

test("the default filters narrow nothing", () => {
  expect(activeFilters(defaultFilters)).toEqual([]);
});

test("each changed filter is named, with a picked account first", () => {
  expect(
    activeFilters({ owner: "ada", visibility: "private", archived: "all", fork: "no" }, "ada-work"),
  ).toEqual(["account ada-work", "owner ada", "private only", "archived included", "no forks"]);
  expect(activeFilters({ ...defaultFilters, archived: "yes", fork: "yes" })).toEqual([
    "archived only",
    "forks only",
  ]);
});

test("the last answer carries over only when the search text alone changed", () => {
  const key = ["projects", "github-repositories", "m1", "github.com", "ada", "", "doc", "all"];
  expect(onlyTextChanged(key, key.with(6, "docs"), 6)).toBe(true);
  expect(onlyTextChanged(key, key.with(4, "other"), 6)).toBe(false);
  expect(onlyTextChanged(key, key.with(7, "private"), 6)).toBe(false);
});
