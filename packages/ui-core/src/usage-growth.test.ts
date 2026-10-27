import { expect, test } from "vitest";
import { formatTokens } from "./usage-cost.ts";
import { growthBasis, previousSpan, usageGrowth } from "./usage-growth.ts";

test("growth reads a rise or a fall against the period before as a signed percent", () => {
  expect(usageGrowth(112, 100)).toEqual({ direction: "up", label: "+12%" });
  expect(usageGrowth(96.6, 100)).toEqual({ direction: "down", label: "−3.4%" });
  expect(usageGrowth(250, 100)).toEqual({ direction: "up", label: "+150%" });
  expect(usageGrowth(1_400, 100)).toEqual({ direction: "up", label: "14×" });
});

test("growth after an empty period is new, and two empty periods compare nothing", () => {
  expect(usageGrowth(5, 0)).toEqual({ direction: "new", label: "New" });
  expect(usageGrowth(0, 0)).toEqual({ direction: "none", label: "" });
  expect(usageGrowth(100.01, 100)).toEqual({ direction: "flat", label: "No change" });
  expect(usageGrowth(0, 40)).toEqual({ direction: "down", label: "−100%" });
});

test("the previous period is the same number of days ending the day before", () => {
  expect(previousSpan("2026-10-20", "2026-10-26")).toEqual({
    from: "2026-10-13",
    to: "2026-10-19",
  });
  expect(previousSpan("2026-10-26", "2026-10-26")).toEqual({
    from: "2026-10-25",
    to: "2026-10-25",
  });
  expect(previousSpan("2026-03-01", "2026-03-30")).toEqual({
    from: "2026-01-30",
    to: "2026-02-28",
  });
  expect(growthBasis(1)).toBe("vs yesterday");
  expect(growthBasis(30)).toBe("vs previous 30 days");
});

test("token counts read in compact K, M and B and never round up into the wrong unit", () => {
  expect(formatTokens(19_300_000_000)).toBe("19.3B");
  expect(formatTokens(412_000)).toBe("412K");
  expect(formatTokens(1_240_000)).toBe("1.2M");
  expect(formatTokens(999_600)).toBe("1M");
  expect(formatTokens(250_000_000)).toBe("250M");
  expect(formatTokens(999_960_000)).toBe("1B");
  expect(formatTokens(842)).toBe("842");
});
