import { expect, it } from "vitest";
import { CrashBackoff } from "./crash-backoff.ts";

it("a page that keeps crashing reloads at once, then after a pause, then stays crashed", () => {
  const backoff = new CrashBackoff({ windowMs: 60_000, delaysMs: [0, 2_000] });
  expect(backoff.crashed(1_000)).toEqual({ kind: "reload", delayMs: 0 });
  expect(backoff.crashed(3_000)).toEqual({ kind: "reload", delayMs: 2_000 });
  expect(backoff.crashed(6_000)).toEqual({ kind: "give-up", crashes: 3 });
  // A manual reload that crashes again within the minute does not start reloading again.
  expect(backoff.crashed(9_000)).toEqual({ kind: "give-up", crashes: 4 });
});

it("crashes far apart each get an immediate reload", () => {
  const backoff = new CrashBackoff({ windowMs: 60_000, delaysMs: [0, 2_000] });
  expect(backoff.crashed(0)).toEqual({ kind: "reload", delayMs: 0 });
  expect(backoff.crashed(61_000)).toEqual({ kind: "reload", delayMs: 0 });
  expect(backoff.crashed(122_000)).toEqual({ kind: "reload", delayMs: 0 });
});
