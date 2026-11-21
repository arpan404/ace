import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { shippedMarketKeys } from "./keys.ts";

test("Spade trusts the same market keys this build verifies with", () => {
  // Spade checks a package's signed manifest itself (ADR 0200 §3.2), with its own copy.
  const spade = JSON.parse(
    readFileSync(new URL("../../../spade/config/market-keys.json", import.meta.url), "utf8"),
  );
  expect(spade).toEqual(shippedMarketKeys);
});
