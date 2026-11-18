import { expect, test } from "vitest";
import { subpathOf } from "./checkout-facts.ts";

test.each([
  { behaviour: "the work tree's top is the root", path: "/code/mono", subpath: "" },
  { behaviour: "a nested folder", path: "/code/mono/apps/web", subpath: "apps/web" },
  { behaviour: "a folder named ..tools is inside", path: "/code/mono/..tools", subpath: "..tools" },
  { behaviour: "a folder named ... is inside", path: "/code/mono/.../x", subpath: ".../x" },
  { behaviour: "a sibling folder is outside", path: "/code/other", subpath: "" },
  { behaviour: "the parent is outside", path: "/code", subpath: "" },
])("$behaviour", ({ path, subpath }) => {
  expect(subpathOf("/code/mono", path)).toBe(subpath);
});
