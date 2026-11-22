import { expect, test } from "vitest";
import { ReadGate } from "./read-gate.ts";

function held() {
  const { promise: done, resolve: release } = Promise.withResolvers<void>();
  return { done, release: () => release() };
}

test("no more than the limit of reads run at once; the next starts when one ends", async () => {
  const gate = new ReadGate(2);
  const running: number[] = [];
  let peak = 0;
  const reads = [held(), held(), held()];
  const results = reads.map((read, index) =>
    gate.run(async () => {
      running.push(index);
      peak = Math.max(peak, running.length);
      await read.done;
      running.splice(running.indexOf(index), 1);
      return index;
    }),
  );
  await Promise.resolve();
  expect(running).toEqual([0, 1]);
  reads[0]?.release();
  await results[0];
  await Promise.resolve();
  expect(running).toEqual([1, 2]);
  reads[1]?.release();
  reads[2]?.release();
  expect(await Promise.all(results)).toEqual([0, 1, 2]);
  expect(peak).toBe(2);
});

test("a waiting read whose caller gave up leaves the queue without running", async () => {
  const gate = new ReadGate(1);
  const first = held();
  const busy = gate.run(() => first.done);
  const controller = new AbortController();
  let ran = false;
  const waiting = gate.run(async () => {
    ran = true;
  }, controller.signal);
  controller.abort();
  await expect(waiting).rejects.toMatchObject({ code: "git_cancelled" });
  first.release();
  await busy;
  expect(ran).toBe(false);
  // The slot it would have taken is free for the next read.
  expect(await gate.run(async () => "next")).toBe("next");
});
