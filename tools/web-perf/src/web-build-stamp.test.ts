import { expect, test } from "vitest";
import { staleBuild } from "./web-build-stamp.ts";

const commit = "a".repeat(40);

test("a build stamped with this clean commit is reused", () => {
  expect(staleBuild({ commit }, { commit, dirty: false })).toBeUndefined();
});

test("a build from another commit, without a stamp, or with edited sources is rebuilt", () => {
  expect(staleBuild({ commit: "b".repeat(40) }, { commit, dirty: false })).toMatch(/built from b/);
  expect(staleBuild(undefined, { commit, dirty: false })).toMatch(/no build stamp/);
  expect(staleBuild({ commit }, { commit, dirty: true })).toMatch(/changed since the last commit/);
});
