import { expect, test } from "vitest";
import { availability, ingestQuota, initialQuota } from "./index.ts";

test("uncertified quota maps are never enumerated, read or taken for a limit", () => {
  let accesses = 0;
  const map = new Proxy(
    {},
    {
      ownKeys: () => {
        accesses++;
        throw new Error("Unbounded enumeration");
      },
      get: () => {
        accesses++;
        throw new Error("Unbounded read");
      },
    },
  );
  const payload = { rate_limits: map };
  const result = ingestQuota(
    { ...initialQuota(), auth: "logged_in" },
    {
      provider: "claude",
      payload,
      observedAt: 1,
      timeZone: "UTC",
    },
  );
  expect(accesses).toBe(0);
  expect(availability(result.state, 1)).toBe("available");
  expect(result.raw).toBe(payload);
});
