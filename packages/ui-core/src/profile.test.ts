import { describe, expect, test } from "vitest";
import { initials } from "./profile.ts";

describe("account initials", () => {
  test("take the first and last name", () => {
    expect(initials("Arpan Bhandari")).toBe("AB");
    expect(initials("  ada   king lovelace ")).toBe("AL");
  });
  test("a single name gives one letter", () => {
    expect(initials("ada")).toBe("A");
  });
  test("a blank name gives none, so the caller can fall back", () => {
    expect(initials("   ")).toBe("");
  });
  test("non-Latin names keep whole characters", () => {
    expect(initials("Émile Ångström")).toBe("ÉÅ");
  });
});
