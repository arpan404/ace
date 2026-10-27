import { expect, test } from "vitest";
import { readFamily, writeFamilies } from "./read-policy.ts";

/* What the phone's skill and plugin requests keep, and what they put out of date. */

test("reading which agents each plugin reaches is kept and puts nothing out of date", () => {
  const read = { type: "plugins.native", op: "plugins" };
  expect(readFamily(read)).toBe("plugins");
  expect(writeFamilies(read)).toEqual([]);
});

test("switching a plugin or one of its agents puts plugins, the catalog and skills out of date", () => {
  for (const change of [
    { type: "plugins.native", op: "switch", name: "engineering", enabled: false },
    { type: "plugins.native", op: "agent", name: "engineering", provider: "pi", on: true },
  ]) {
    expect(readFamily(change)).toBeUndefined();
    expect(writeFamilies(change)).toEqual(["plugins", "catalog", "skills"]);
  }
});

test("a plugin request of no known kind puts nothing out of date", () => {
  expect(writeFamilies({ type: "plugins.native", op: "unknown" })).toEqual([]);
});

test("opening a skill on the computer, and its other lookups, put nothing out of date", () => {
  for (const op of ["skill", "draft", "check", "openers", "open"])
    expect(writeFamilies({ type: "skills.native", op })).toEqual([]);
  expect(writeFamilies({ type: "skills.native", op: "edit" })).toEqual(["skills", "catalog"]);
});
