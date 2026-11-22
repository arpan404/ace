import { expect, test } from "vitest";
import { eventFamilies, keepable, readFamily, writeFamilies } from "./read-policy.ts";

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

test("checking a skill for an update puts nothing out of date; applying one does", () => {
  for (const op of ["checkUpdate", "prepareUpdate", "cancelUpdate"])
    expect(writeFamilies({ type: "skills.native", op })).toEqual([]);
  expect(writeFamilies({ type: "skills.native", op: "applyUpdate" })).toEqual([
    "skills",
    "catalog",
  ]);
});

test("looking for installed CLIs again puts providers, the catalog and settings out of date", () => {
  const rediscover = { type: "providers.request", operation: "refresh" };
  expect(readFamily(rediscover)).toBeUndefined();
  expect(writeFamilies(rediscover)).toEqual(["providers", "catalog", "settings", "settings-page"]);
});

test("a Verify run moving reads the merge strip again, not the pull request lists", () => {
  const strip = { type: "forge.merge-run", project: "ace", picked: [], rows: [] };
  const family = readFamily(strip);
  expect(family).toBeDefined();
  expect(eventFamilies("verify.changed")).toContain(family);
  expect(eventFamilies("verify.changed")).not.toContain(readFamily({ type: "forge.pulls" }));
  // Starting or stopping a run reads both again: what merged leaves the list.
  expect(writeFamilies({ type: "forge.merge-run.write" })).toEqual(
    expect.arrayContaining([family, readFamily({ type: "forge.pulls" })]),
  );
});

const market = (operation: Record<string, unknown>) => ({ type: "market.native", operation });

test("the market's home, listings, entries and Installed are kept; a review never is", () => {
  expect(readFamily(market({ op: "home" }))).toBe("market");
  expect(readFamily(market({ op: "installed" }))).toBe("market");
  expect(readFamily(market({ op: "readReview", id: "r1" }))).toBeUndefined();
  expect(
    writeFamilies(market({ op: "prepare", source: "market", type: "suit", name: "x" })),
  ).toEqual([]);
});

test("installing or removing from the market puts the market, skills and plugins out of date", () => {
  for (const op of [
    { op: "install", id: "r1", hash: "h" },
    { op: "remove", type: "suit", name: "x" },
  ])
    expect(writeFamilies(market(op))).toEqual(["market", "skills", "plugins", "catalog"]);
});

test("the daemon's marketplace.changed puts the market's kept reads out of date", () => {
  expect(eventFamilies("marketplace.changed")).toEqual(["market"]);
});

test("an answer kept from before the machine went offline is shown but not kept as fresh", () => {
  expect(keepable({ ok: true, offline: false, rows: [] })).toBe(true);
  expect(keepable({ ok: true, offline: true, rows: [] })).toBe(false);
});
