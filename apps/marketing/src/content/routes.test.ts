import { expect, test } from "vitest";
import { features } from "./features.ts";
import { route, routes, trail } from "./routes.ts";

test("a feature page's breadcrumb runs Home, Features, then the feature", () => {
  const fleet = features.find((feature) => feature.slug === "fleet");
  expect(trail("/features/fleet/").map((step) => step.name)).toEqual([
    "Home",
    "Features",
    fleet?.name,
  ]);
});

test("the home page's trail is just the home page", () => {
  expect(trail("/").map((step) => step.path)).toEqual(["/"]);
});

test("every page's parent is itself a page, so no breadcrumb dead-ends", () => {
  for (const entry of routes) {
    if (entry.parent) expect(() => route(entry.parent ?? "")).not.toThrow();
  }
});

test("no two pages share a path, and every path ends in a slash like the built URLs", () => {
  const paths = routes.map((entry) => entry.path);
  expect(new Set(paths).size).toBe(paths.length);
  for (const path of paths) expect(path).toMatch(/^\/(?:.*\/)?$/);
});

test("a path that isn't a page is refused, so a missing route can't go unnoticed", () => {
  expect(() => trail("/nowhere/")).toThrow(/No route/);
});
