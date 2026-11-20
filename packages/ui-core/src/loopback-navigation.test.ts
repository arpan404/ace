import { describe, expect, test } from "vitest";
import cases from "./loopback-navigation-cases.json" with { type: "json" };
import { loopbackNavigationAllowed } from "./loopback-navigation.ts";

/* `cases` is the table the phone's Swift copy of the rule is tested against too. */

describe("which top-level navigations reach the machine's localhost", () => {
  test.each(cases.map((entry) => [entry.case, entry] as const))("%s", (_, entry) => {
    expect(loopbackNavigationAllowed(entry)).toBe(entry.allowed);
  });
});
