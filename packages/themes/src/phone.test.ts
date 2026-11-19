import { designTokens } from "@ace/design-tokens";
import { describe, expect, it } from "vitest";
import {
  phoneColourRoles,
  phoneContrastWarnings,
  phoneCustomAccent,
  phoneOverrides,
  type PhoneColours,
} from "./phone.ts";
import { themeIds } from "./palettes.ts";

const tokens = (scheme: "light" | "dark"): PhoneColours => {
  const colours: Record<string, string> = designTokens.schemes[scheme].colours;
  return Object.fromEntries(
    phoneColourRoles.map((role) => [role, colours[role] ?? "#000000"]),
  ) as PhoneColours;
};
const base = { light: tokens("light"), dark: tokens("dark") };

describe("phone themes", () => {
  it("reads at AA on every phone surface in every theme, accent and scheme", () => {
    expect(phoneContrastWarnings(base)).toEqual([]);
  });

  it("fits hard custom colours to read at AA in every theme and scheme", () => {
    const hard = ["#FFFFF0", "#FFFFFF", "#050505", "#000000", "#FFE600", "#00FF00", "#FF00FF"];
    expect(phoneContrastWarnings(base, hard)).toEqual([]);
  });

  it("fits a custom colour differently for light and dark pages, and refuses a non-colour", () => {
    const fit = phoneCustomAccent("#FFE600");
    expect(fit?.paper.light.accent).not.toBe(fit?.paper.dark.accent);
    expect(phoneCustomAccent("yellow")).toBeUndefined();
    expect(phoneCustomAccent("#FFE60080")).toBeUndefined();
  });

  it("flags a theme whose words would not read", () => {
    const washedOut = { ...base, light: { ...base.light, mutedForeground: "#DDDDDD" } };
    const warnings = phoneContrastWarnings(washedOut);
    expect(warnings.some((w) => w.theme === "ace" && w.label === "mutedForeground")).toBe(true);
  });

  it("leaves ace with its own accent on the design tokens", () => {
    expect(phoneOverrides("ace", "theme", "light")).toEqual({});
    expect(phoneOverrides("ace", "theme", "dark")).toEqual({});
  });

  it("changes only the accent when another accent is laid over ace", () => {
    const overrides = phoneOverrides("ace", "teal", "dark");
    expect(Object.keys(overrides).toSorted()).toEqual(["accent", "onAccent"]);
    expect(overrides.accent).not.toBe(base.dark.accent);
  });

  it("gives every other theme its own page and ink in both schemes", () => {
    for (const theme of themeIds.filter((id) => id !== "ace"))
      for (const scheme of ["light", "dark"] as const) {
        const overrides = phoneOverrides(theme, "theme", scheme);
        expect(overrides.background).not.toBe(base[scheme].background);
        expect(Object.keys(overrides)).toHaveLength(phoneColourRoles.length);
      }
  });
});
