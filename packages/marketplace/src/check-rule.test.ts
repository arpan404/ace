import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkRule, readCheckRule } from "./check-rule.ts";

/**
 * The conformance suite's rule cases (`spade/spec/conformance/package/check-rules.json`), which
 * Spade's reader runs too (`spade_core::quality::rule`).
 */
const all = JSON.parse(
  readFileSync(
    new URL("../../../spade/spec/conformance/package/check-rules.json", import.meta.url),
    "utf8",
  ),
) as {
  cases: {
    id: string;
    check: unknown;
    rule?: string;
    fits?: unknown[];
    misfits?: { value: unknown; at: string }[];
  }[];
};

describe("the check rule subset both readers share", () => {
  it.each(all.cases.map((c) => [c.id, c] as const))("%s", (_name, c) => {
    const read = readCheckRule(c.check, "rule");
    if (c.rule !== undefined) {
      expect(read.problems.map((p) => p.rule)).toContain(c.rule);
      return;
    }
    expect(read.problems).toEqual([]);
    const rule = read.rule;
    if (!rule) throw new Error("read without a rule");
    for (const value of c.fits ?? []) expect(checkRule(rule, value, "output")).toEqual([]);
    for (const miss of c.misfits ?? [])
      expect(checkRule(rule, miss.value, "output").map((m) => m.at)).toContain(miss.at);
  });
});
