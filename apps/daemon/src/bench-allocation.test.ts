import { expect, test } from "vitest";
import { allocationMarkers, windowAllocation } from "../bench/allocation-meter.ts";

const main = "0x1000";
const worker = "0x2000";
const collection = (heap: string, kb: number) =>
  `[GC<${heap}>: START M 5451kb => EdenCollection, ca=${kb}kb h=4033kb a=0kb`;

test("a window counts the main isolate's collections after its start, including the closing one", () => {
  const log = [
    collection(main, 900), // the opening forced collection: before the window
    allocationMarkers.start,
    collection(main, 100),
    collection(worker, 7),
    collection(main, 200),
    allocationMarkers.stop,
    collection(main, 50), // the closing forced collection: the remainder since the last one
    allocationMarkers.end,
  ].join("\n");
  expect(windowAllocation(log)).toEqual({
    mainBytes: 350 * 1024,
    workerBytes: 7 * 1024,
    mainCollections: 2,
  });
});

test("a marker written inside a worker's half-logged collection still bounds the window", () => {
  const log = `${collection(main, 900)}\n[GC<${worker}>: START M 1kb ${allocationMarkers.start}\n => Eden ca=3kb END]\n${collection(main, 40)} ${allocationMarkers.stop}\n${collection(main, 10)}\n${allocationMarkers.end}\n`;
  expect(windowAllocation(log)).toEqual({
    mainBytes: 50 * 1024,
    workerBytes: 0,
    mainCollections: 1,
  });
});

test("a window is unread until its end marker arrives", () => {
  const log = [collection(main, 900), allocationMarkers.start, collection(main, 100)].join("\n");
  expect(windowAllocation(log)).toBeUndefined();
});

test("a log without collections fails instead of reading as no allocation", () => {
  const log = [allocationMarkers.start, allocationMarkers.stop, allocationMarkers.end].join("\n");
  expect(() => windowAllocation(log)).toThrow(/BUN_JSC_logGC/);
});
