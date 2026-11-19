import { expect, test } from "vitest";
import { growthSentence, priceNote, usageMoney, usagePercent } from "./usage-format.ts";

test("money is whole dollars once the period reaches $100, cents below", () => {
  const large = usageMoney(1518);
  expect([990.4, 430, 72.39, 25.69].map(large)).toEqual(["$990", "$430", "$72", "$26"]);
  const small = usageMoney(42);
  expect([4.271, 0.004].map(small)).toEqual(["$4.27", "<$0.01"]);
});

test("shares read to one decimal", () => {
  expect([0.553, 0.0004, 0, 1].map(usagePercent)).toEqual(["55.3%", "<0.1%", "0%", "100.0%"]);
});

test("change against the period before is said in words, never a bare sign", () => {
  expect(growthSentence(93.4, 100, 30)).toBe("6.6% less than the previous 30 days");
  expect(growthSentence(118, 100, 1)).toBe("18.0% more than yesterday");
  expect(growthSentence(100, 100, 30)).toBe("About the same as the previous 30 days");
  expect(growthSentence(5, 0, 30)).toBe("Nothing in the previous 30 days to compare");
  expect(growthSentence(0, 0, 30)).toBeUndefined();
});

test("the price note names LiteLLM and the newest price date among the machines read", () => {
  expect(
    priceNote([
      { priceVersion: "litellm-2026-10-30/contract-v2", priceAsOf: "2026-10-30" },
      { priceVersion: "litellm-2026-11-01/contract-v2", priceAsOf: "2026-11-01" },
    ]),
  ).toBe("Prices from LiteLLM, updated Nov 1, 2026");
  expect(priceNote([{ priceVersion: "2026-10-07.1", priceAsOf: "2026-10-07" }])).toBe(
    "Prices from ace's price table, updated Oct 7, 2026",
  );
  expect(priceNote([{ priceVersion: "litellm-x" }])).toBeUndefined();
});
