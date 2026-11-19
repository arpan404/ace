import { expect, it } from "vitest";
import type { FileSearchFile, FileSearchLine } from "@ace/protocol";
import { SearchBatches } from "./search-batches.ts";
import { TestClock } from "./test-clock.ts";

function lines(count: number, preview = "a needle"): FileSearchLine[] {
  return Array.from({ length: count }, (_, index) => ({
    line: index + 1,
    column: 0,
    preview,
    ranges: Array.from({ length: 64 }, (_, at) => [at, at + 1] as [number, number]),
  }));
}

const wireBytes = (files: FileSearchFile[]) => Buffer.byteLength(JSON.stringify(files));

it("no batch of long paths and wide lines passes the byte cap, and every line still goes", () => {
  const clock = new TestClock();
  const sent: FileSearchFile[][] = [];
  const queue = new SearchBatches({ clock, ready: () => true, send: (files) => sent.push(files) });
  const preview = "é".repeat(190);
  for (let index = 0; index < 200; index++)
    queue.add(`${"deep/".repeat(200)}file-${index}.ts`, lines(1, preview));
  clock.advance(50);
  const total = sent.flatMap((files) => files.flatMap((file) => file.lines)).length;
  expect(total).toBe(200);
  expect(sent.length).toBeGreaterThan(1);
  for (const files of sent) expect(wireBytes(files)).toBeLessThanOrEqual(32 * 1024);
});

it("a drained search finishes only once the connection could take another message", async () => {
  const clock = new TestClock();
  let ready = true;
  const sent: FileSearchFile[][] = [];
  const queue = new SearchBatches({
    clock,
    ready: () => ready,
    send: (files) => {
      sent.push(files);
      ready = false;
    },
  });
  queue.add("a.ts", lines(3));
  let done = false;
  const drained = queue.drain().then(() => (done = true));
  await Promise.resolve();
  expect(sent).toHaveLength(1);
  expect(done).toBe(false);
  ready = true;
  clock.advance(50);
  await drained;
  expect(done).toBe(true);
});
