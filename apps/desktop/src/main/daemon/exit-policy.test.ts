import { exitCodes } from "@ace/service/exit-codes";
import { expect, test } from "vitest";
import { exitDecision } from "./exit-policy.ts";

const base = { signal: null, maxRestarts: 5, safeModeAfter: 2 };

test.each([
  // code, fast failures before this one, what happens next
  [1, 0, { kind: "restart", delayMs: 500, safeMode: false }],
  [1, 1, { kind: "restart", delayMs: 1_000, safeMode: true }],
  [1, 4, { kind: "restart", delayMs: 8_000, safeMode: true }],
  [1, 5, { kind: "give-up" }],
  [exitCodes["address-in-use"], 1, { kind: "restart", cause: "port-in-use", safeMode: false }],
  [exitCodes["lock-held"], 4, { kind: "lock-held" }],
  [exitCodes["newer-data"], 0, { kind: "newer-data" }],
  [exitCodes["incompatible-data"], 3, { kind: "incompatible-data" }],
] as const)("exit code %i after %i fast failures: %o", (code, crashes, expected) => {
  expect(exitDecision({ ...base, code, crashes })).toMatchObject(expected);
});

test("restart delays grow and stop growing at 30 s", () => {
  const delays = [0, 1, 2, 3, 4, 5, 6, 7].map(
    (crashes) =>
      exitDecision({ ...base, maxRestarts: 10, code: 1, crashes }) as { delayMs: number },
  );
  expect(delays.map((decision) => decision.delayMs)).toEqual([
    500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
  ]);
});
