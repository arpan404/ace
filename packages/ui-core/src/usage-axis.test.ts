import { expect, test } from "vitest";
import { usageAxis } from "./usage-axis.ts";

const labels = (axis: ReturnType<typeof usageAxis>) => axis.ticks.map((tick) => tick.label);

test("a cost chart's axis climbs in round dollars to the first step past its peak", () => {
  expect(labels(usageAxis(49.06, "usd"))).toEqual(["$0", "$25", "$50"]);
  expect(usageAxis(49.06, "usd").top).toBe(50);
  expect(labels(usageAxis(51, "usd"))).toEqual(["$0", "$50", "$100"]);
  expect(labels(usageAxis(3.4, "usd"))).toEqual(["$0", "$2", "$4"]);
  expect(labels(usageAxis(4.4, "usd"))).toEqual(["$0", "$2.50", "$5.00"]);
  expect(labels(usageAxis(0.07, "usd"))).toEqual(["$0", "$0.05", "$0.10"]);
  expect(labels(usageAxis(2_900, "usd"))).toEqual(["$0", "$2K", "$4K"]);
  expect(labels(usageAxis(4_800, "usd"))).toEqual(["$0", "$2.5K", "$5K"]);
});

test("a token chart's axis reads in compact units on round steps", () => {
  expect(labels(usageAxis(8_200_000, "tokens"))).toEqual(["0", "5M", "10M"]);
  expect(labels(usageAxis(96_000_000, "tokens"))).toEqual(["0", "50M", "100M"]);
  expect(labels(usageAxis(1_000_000_000, "tokens"))).toEqual(["0", "500M", "1B"]);
  expect(labels(usageAxis(1_400, "tokens"))).toEqual(["0", "1K", "2K"]);
  expect(labels(usageAxis(4_100, "tokens"))).toEqual(["0", "2.5K", "5K"]);
});

test("an empty chart has only its zero line", () => {
  expect(usageAxis(0, "usd")).toEqual({ ticks: [{ value: 0, label: "$0" }], top: 1 });
  expect(labels(usageAxis(0, "tokens"))).toEqual(["0"]);
});
