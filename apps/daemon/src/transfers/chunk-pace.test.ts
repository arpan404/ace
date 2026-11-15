import { expect, test } from "vitest";
import { transferChunkBytes } from "@ace/protocol";
import { ChunkPace } from "./chunk-pace.ts";

const MiB = 1024 * 1024;
/** 400 kbit/s, a laptop tethered to a phone, in bytes per millisecond. */
const tethered = 400_000 / 8 / 1000;

test("a fast link sends full chunks once one has gone through", () => {
  const pace = new ChunkPace();
  expect(pace.size(100 * MiB)).toBe(MiB);
  pace.sent(MiB, 20);
  expect(pace.size(100 * MiB)).toBe(transferChunkBytes);
  expect(pace.size(1000)).toBe(1000);
});

test("a slow link sends chunks that take about 20 s, each given time in proportion", () => {
  const pace = new ChunkPace();
  pace.sent(MiB, MiB / tethered);
  const size = pace.size(100 * MiB);
  expect(size).toBeLessThan(transferChunkBytes);
  expect(size / tethered).toBeLessThanOrEqual(20_000);
  expect(size / tethered).toBeGreaterThan(15_000);
  // Room for the chunk at the measured speed, well past it, never as short as on a LAN.
  expect(pace.timeoutMs(size)).toBeGreaterThan(2 * (size / tethered));
});

test("before anything is measured a chunk keeps the old two-minute timeout", () => {
  expect(new ChunkPace().timeoutMs(MiB)).toBe(120_000);
});

test("a chunk that timed out makes the next one smaller, down to a floor", () => {
  const pace = new ChunkPace();
  const first = pace.size(100 * MiB);
  pace.timedOut(first, 120_000);
  const retry = pace.size(100 * MiB);
  expect(retry).toBeLessThan(first);
  for (let i = 0; i < 10; i++) pace.timedOut(pace.size(100 * MiB), 30_000);
  expect(pace.size(100 * MiB)).toBe(256 * 1024);
});
