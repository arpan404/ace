import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { loopbackNavigationAllowed, type LoopbackNavigation } from "./loopback-navigation.ts";

/** The table the phone's Swift copy of the rule is tested against too. */
const cases = JSON.parse(
  readFileSync(new URL("./loopback-navigation-cases.json", import.meta.url), "utf8"),
) as (LoopbackNavigation & { case: string; allowed: boolean })[];

describe("which top-level navigations reach the machine's localhost", () => {
  test.each(cases.map((entry) => [entry.case, entry] as const))("%s", (_, entry) => {
    expect(loopbackNavigationAllowed(entry)).toBe(entry.allowed);
  });
});
