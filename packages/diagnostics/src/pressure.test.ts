import { describe, expect, it } from "vitest";
import { loadAwareBudget, memoryLevelOf, parsePsi, pressureVerdict } from "./pressure.ts";

const psiText = (some: number, full?: number) =>
  [
    `some avg10=${some} avg60=${some} avg300=1.00 total=123456`,
    ...(full === undefined ? [] : [`full avg10=${full} avg60=${full} avg300=0.50 total=6543`]),
  ].join("\n");

describe("reading PSI", () => {
  it("reads both lines and ignores fields it does not know", () => {
    expect(parsePsi(psiText(42.5, 7.1) + "\nwhatever else=1\n")).toEqual({
      some: { avg10: 42.5, avg60: 42.5 },
      full: { avg10: 7.1, avg60: 7.1 },
    });
  });
  it("gives nothing for text without a PSI line", () => {
    expect(parsePsi("")).toBeUndefined();
    expect(parsePsi("some avg10=abc")).toBeUndefined();
  });
});

describe("whether the machine is overloaded", () => {
  it.each([
    ["idle", { cpus: 16, load1: 2 }, false],
    ["the incident's load on 16 CPUs", { cpus: 16, load1: 96 }, true],
    ["CPU pressure", { cpus: 16, load1: 4, cpu: parsePsi(psiText(55)) }, true],
    ["memory thrashing", { cpus: 16, load1: 4, memory: parsePsi(psiText(10, 9)) }, true],
    ["I/O stalls", { cpus: 16, load1: 4, io: parsePsi(psiText(30, 25)) }, true],
    [
      "light PSI",
      { cpus: 16, load1: 4, cpu: parsePsi(psiText(5)), io: parsePsi(psiText(2, 1)) },
      false,
    ],
    ["macOS memory warning", { cpus: 10, load1: 3, memoryLevel: memoryLevelOf("2\n") }, true],
    ["macOS memory normal", { cpus: 10, load1: 3, memoryLevel: memoryLevelOf("1") }, false],
    ["Windows nearly out of memory", { cpus: 8, load1: 0, freeMemory: 0.02 }, true],
  ])("%s", (_name, pressure, heavy) => {
    const verdict = pressureVerdict(pressure);
    expect(verdict.heavy).toBe(heavy);
    expect(verdict.reasons.length > 0).toBe(heavy);
  });

  it("scales a budget only when it is", () => {
    expect(loadAwareBudget(15_000, pressureVerdict({ cpus: 16, load1: 1 }))).toBe(15_000);
    expect(loadAwareBudget(15_000, pressureVerdict({ cpus: 16, load1: 100 }))).toBe(60_000);
  });
});
