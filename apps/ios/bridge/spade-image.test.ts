import { expect, test } from "vitest";
import { SpadeImageBudget } from "./spade-image.ts";

/*
 * Pictures read for a Spade chat hold at most so many bytes in flight: a chat scrolled past many
 * images reads them a few at a time, never all at once.
 */

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a read past the budget waits until enough of the bytes in flight are done", async () => {
  const budget = new SpadeImageBudget(10);
  const order: string[] = [];
  const read = (name: string, bytes: number, done: Promise<void>) =>
    budget.run(bytes, async () => {
      order.push(`start ${name}`);
      await done;
      order.push(`end ${name}`);
    });
  const gate = Promise.withResolvers<void>();
  const first = read("a", 6, gate.promise);
  const second = read("b", 6, Promise.resolve());
  await settled();
  expect(order).toEqual(["start a"]);

  gate.resolve();
  await Promise.all([first, second]);
  expect(order).toEqual(["start a", "end a", "start b", "end b"]);
});

test("reads that fit together run together, and one larger than the budget still runs alone", async () => {
  const budget = new SpadeImageBudget(10);
  const running: number[] = [];
  let most = 0;
  const read = (bytes: number) =>
    budget.run(bytes, async () => {
      running.push(bytes);
      most = Math.max(most, running.length);
      await settled();
      running.splice(running.indexOf(bytes), 1);
    });

  await Promise.all([read(4), read(4), read(30), read(4)]);

  expect(most).toBe(2);
  expect(running).toEqual([]);
});

test("a read that fails gives its bytes back to the budget", async () => {
  const budget = new SpadeImageBudget(10);

  await expect(budget.run(8, () => Promise.reject(new Error("gone")))).rejects.toThrow("gone");

  await expect(budget.run(8, async () => "next")).resolves.toBe("next");
});
