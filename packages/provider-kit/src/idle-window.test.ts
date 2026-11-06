import { expect, test } from "vitest";
import { nextIdleWindow } from "./idle-window.ts";

const policy = { baseMs: 5_000, maxMs: 120_000 };

test.each([
  { currentMs: 5_000, quietMs: 25_000, expected: 10_000 },
  { currentMs: 40_000, quietMs: 20_000, expected: 80_000 },
  { currentMs: 120_000, quietMs: 480_000, expected: 5_000 },
  { currentMs: 80_000, quietMs: 1_000_000, expected: 5_000 },
  { currentMs: 80_000, quietMs: -1, expected: 5_000 },
  { currentMs: 80_000, quietMs: 100_000, expected: 120_000 },
])(
  "idle window adapts to reuse after $quietMs ms retired and then releases after long quiet",
  ({ currentMs, quietMs, expected }) => {
    expect(nextIdleWindow(policy, currentMs, quietMs)).toBe(expected);
  },
);
