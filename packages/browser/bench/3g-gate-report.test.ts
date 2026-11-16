import { describe, expect, it } from "vitest";
import { gateMarkdown, gateRow, linkResult, type LinkResult } from "./3g-gate-report.ts";

const result = (over: Partial<LinkResult> = {}): LinkResult => ({
  median: 60,
  p10: 59,
  megabitsPerSecond: 4.4,
  codedWidth: 2560,
  glassToGlassMs: { p50: 88, p95: 130 },
  ...over,
});
const run = (profile: "phone" | "3g-1600" | "3g-400", over: Partial<LinkResult> = {}) =>
  gateRow({ profile, startedAt: "02:00", maxLoad: 12.3, result: result(over) });

describe("the 3G gate's merge bar", () => {
  it("holds 25 Mbit/s to about 60 fps", () => {
    expect(run("phone").met).toBe(true);
    expect(run("phone", { median: 57 }).met).toBe(false);
    expect(run("phone", { p10: 50 }).met).toBe(false);
  });

  it("asks 3g-1600 for 15 fps of a readable picture within a second", () => {
    const thin = { median: 15, codedWidth: 1152, glassToGlassMs: { p50: 1_000, p95: 1_800 } };
    expect(run("3g-1600", thin).met).toBe(true);
    expect(run("3g-1600", { ...thin, median: 5 }).met).toBe(false);
    expect(run("3g-1600", { ...thin, codedWidth: 1070 }).met).toBe(false);
    expect(run("3g-1600", { ...thin, glassToGlassMs: { p50: 1_001, p95: 1_800 } }).met).toBe(false);
  });

  it("asks 3g-400 only for its lag, and a run with no lag measured fails", () => {
    expect(run("3g-400", { median: 2, glassToGlassMs: { p50: 1_500, p95: 4_000 } }).met).toBe(true);
    expect(run("3g-400", { glassToGlassMs: { p50: null, p95: null } }).met).toBe(false);
  });
});

describe("the gate's report", () => {
  it("tables the clean runs and names what is missing or was thrown away", () => {
    const markdown = gateMarkdown({
      maxLoad: 24,
      deadline: "07:00",
      finishedAt: "03:10",
      rows: [run("phone"), run("3g-1600", { median: 5, codedWidth: 1070 })],
      discarded: [{ profile: "3g-400", startedAt: "02:40", maxLoad: 61.2 }],
      missing: ["3g-400"],
    });
    expect(markdown).toContain("| phone | 02:00 | 12.3 | 60 / 59 | 4.4 | 2560 | 88 ms / 130 ms |");
    expect(markdown).toContain("| **no** |");
    expect(markdown).toContain("No clean run before the deadline: 3g-400.");
    expect(markdown).toContain("3g-400 at 02:40 (max 61.2)");
  });
});

describe("reading a bench result line", () => {
  it("keeps what the gate needs, and refuses a line without frame rates", () => {
    expect(
      linkResult({
        median: 6,
        p10: 3,
        megabitsPerSecond: 0.69,
        codedWidth: 1070,
        glassToGlassMs: { p50: 1050, p95: 2423 },
        extra: true,
      }),
    ).toEqual(
      result({
        median: 6,
        p10: 3,
        megabitsPerSecond: 0.69,
        codedWidth: 1070,
        glassToGlassMs: { p50: 1050, p95: 2423 },
      }),
    );
    expect(linkResult({ path: "x", skipped: "no Chrome" })).toBeUndefined();
    expect(linkResult(null)).toBeUndefined();
  });
});
