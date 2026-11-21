import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readRecipe } from "./recipe.ts";
import { ruleIds } from "./rules.ts";

/** The rule table both readers name refusals by, written from `spade_core::rule`. */
const table = JSON.parse(
  readFileSync(new URL("../../../spade/spec/conformance/rules.json", import.meta.url), "utf8"),
) as { rules: { id: string }[] };

const base = {
  format: "spade-bot",
  version: 3,
  requires: { runtime: "1" },
  name: "Flight watcher",
  pricing: { kind: "free" },
};
const read = (fields: Record<string, unknown>) =>
  readRecipe(JSON.stringify({ ...base, ...fields }), new Set(), { spade: "0.0.25" });

describe("the marketplace reader's rules", () => {
  it("names refusals by exactly the ids Spade's rule table gives", () => {
    expect([...ruleIds]).toEqual(table.rules.map((rule) => rule.id));
  });

  it("keeps the spec version a package was written for, and reads a missing one as none", () => {
    expect(read({ spec: "1.2" }).recipe?.spec).toBe("1.2");
    expect(read({}).recipe?.spec).toBeUndefined();
  });

  it("names the rule of every refusal a package breaks", () => {
    const problems = read({ spec: "2.0", publisher: "acme", triggers: {} }).problems;
    expect(problems.map((problem) => problem.rule).toSorted()).toEqual([
      "package.identity",
      "package.spec",
      "package.triggers",
    ]);
  });
});
