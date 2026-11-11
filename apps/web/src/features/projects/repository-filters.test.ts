import { expect, test } from "vitest";
import { activeFilters, defaultFilters, onlyTypedChanged } from "./repository-filters.ts";

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

test("the last answer carries over only when typed parts alone changed", () => {
  const key = ["projects", "github-repositories", "m1", "github.com", "ada", "", "doc", "all"];
  const typed = [4, 5, 6];
  expect(onlyTypedChanged(key, key.with(6, "docs"), typed)).toBe(true);
  expect(onlyTypedChanged(key, key.with(4, "other").with(5, "ace-org"), typed)).toBe(true);
  expect(onlyTypedChanged(key, key.with(3, "ghe.example"), typed)).toBe(false);
  expect(onlyTypedChanged(key, key.with(7, "private"), typed)).toBe(false);
});
