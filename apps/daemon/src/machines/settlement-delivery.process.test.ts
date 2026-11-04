import { expect, test } from "vitest";
import { done, machine, working } from "./children-test-support.ts";
import { MachineFailure } from "./transport.ts";

const failure = {
  code: "usage_limited",
  message: "Account Primary is out of usage until reset.",
  accountId: "account-a",
  accountLabel: "Primary",
  resetsAt: 5000,
} as const;

test("a slow machine never delays a result already received from another machine", async () => {
  const h = machine();
  h.report(h.add("slow", "a-studio"), working);
  h.report(h.add("fast", "z-laptop"), done("Ready immediately"));
  const held = h.holdNextStatus();
  const poll = h.children.poll();
  try {
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.delivered.join("\n")).toContain("Ready immediately");
  } finally {
    held.release();
    await poll;
  }
});

test("an offline child's failure is delivered after reconnect and source restart, with its reason intact", async () => {
  const h = machine();
  const child = h.add("limited");
  h.reads.error = new MachineFailure("offline");
  await h.children.poll();
  expect(h.delivered).toEqual([]);
  h.children.close();
  const restored = machine(h.home);
  restored.report(child, {
    state: "failed",
    status: { state: "failed" },
    failure,
    result: failure.message,
  });
  await restored.children.poll();
  expect(restored.children.watched(child)?.view).toMatchObject({
    state: "failed",
    failure,
    result: failure.message,
  });
  expect(restored.delivered).toHaveLength(1);
  expect(restored.delivered[0]).toContain("usage_limited");
  await restored.children.poll();
  expect(restored.delivered).toHaveLength(1);
});
