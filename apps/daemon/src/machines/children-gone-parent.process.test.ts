import { expect, it } from "vitest";
import { done, machine, working } from "./children-test-support.ts";

/*
 * Children on other machines whose local parent is gone: deleted, and its engine state purged.
 * Nothing about them can be shown in that parent, so they are never applied to it, and never read
 * again and again for it: a parent with no state once made every poll fail and retry each second.
 */

const unapplied = (h: ReturnType<typeof machine>) =>
  h.logs.filter((line) => line.message === "Machine child views not applied");

/** Runs up to `count` of the timers set, in turn, with the clock moved to each. */
async function run(h: ReturnType<typeof machine>, count: number) {
  for (let ran = 0; ran < count && h.timers.length > 0; ran++) await h.step();
}

it("settled children of a parent that is gone leave the re-check instead of being re-read every poll", async () => {
  const first = machine();
  const ids = [first.add("a"), first.add("b")];
  for (const id of ids) first.report(id, done("Done."));
  await first.step();
  for (const id of ids) expect(first.state(id)).toBe("done");
  first.children.close();

  // After a restart, the parent has no engine state; work started there again meanwhile.
  const restarted = machine(first.home, { engine: true });
  for (const id of ids) restarted.report(id, working);
  await run(restarted, 40);

  expect(unapplied(restarted)).toEqual([]);
  expect(restarted.asked.flat()).toEqual([]);
  // Nothing is left to poll for.
  expect(restarted.timers).toEqual([]);
  for (const id of ids) expect(restarted.state(id)).toBe("done");
});

it("a working child of a parent that is gone is stopped and settles there without touching the parent", async () => {
  const first = machine();
  const id = first.add("c");
  first.report(id, working);
  await first.step();
  first.children.close();

  const restarted = machine(first.home, { engine: true });
  restarted.report(id, working);
  await run(restarted, 2);
  // Deleting a parent stops its children: the cancel goes to its machine.
  expect(restarted.cancels).toContain(id);

  restarted.report(id, { state: "cancelled", status: { state: "done" } });
  await run(restarted, 40);
  expect(restarted.state(id)).toBe("cancelled");
  expect(unapplied(restarted)).toEqual([]);
  expect(restarted.timers).toEqual([]);
});

it("a working child of a parent that is gone, on a machine no longer paired, stops being tracked instead of polled every second", async () => {
  const first = machine();
  const id = first.add("d");
  first.report(id, working);
  await first.step();
  first.children.close();

  const restarted = machine(first.home, { engine: true });
  // Its pairing went: no cancel can reach it, and its parent is gone, so no one can be asked.
  restarted.pairings.set("studio", undefined);
  await run(restarted, 40);
  expect(restarted.state(id)).toBe("cancelled");
  expect(restarted.timers).toEqual([]);
});
