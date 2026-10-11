import { expect, it } from "vitest";
import { PolicyGate } from "./policy-call.ts";

it("a page's burst of origin checks waits for capacity instead of losing assets", async () => {
  const gate = new PolicyGate();
  const held = Promise.withResolvers<boolean>();
  const signal = new AbortController().signal;
  const checks = Array.from({ length: 40 }, () => gate.run(signal, () => held.promise));
  held.resolve(true);
  expect(await Promise.all(checks)).toEqual(Array(40).fill(true));
});
it("a closing thread cancels its queued origin checks without blocking another thread", async () => {
  const gate = new PolicyGate();
  const held = Promise.withResolvers<boolean>();
  const blockers = Array.from({ length: 32 }, () =>
    gate.run(new AbortController().signal, () => held.promise),
  );
  const closed = new AbortController();
  const canceled = expect(gate.run(closed.signal, () => true)).rejects.toThrow();
  closed.abort(new Error("Thread closed"));
  await canceled;
  const asset = gate.run(new AbortController().signal, () => true);
  held.resolve(true);
  await Promise.all(blockers);
  expect(await asset).toBe(true);
});
