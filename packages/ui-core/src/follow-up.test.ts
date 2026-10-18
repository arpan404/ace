import { expect, test } from "vitest";
import type { ThreadStatus } from "@ace/protocol";
import { followUpDelivery } from "./follow-up.ts";

const working: ThreadStatus = { state: "working", agents: 1 };
const done: ThreadStatus = { state: "done" };

test("an idle thread leaves delivery to the daemon, so the message starts a turn", () => {
  expect(followUpDelivery({ status: done, canSteer: true, setting: "steer", opposite: true })).toBe(
    undefined,
  );
});

test("while the agent works a steering provider follows the setting, and opposite flips it", () => {
  expect(
    followUpDelivery({ status: working, canSteer: true, setting: "steer", opposite: false }),
  ).toBe("steer");
  expect(
    followUpDelivery({ status: working, canSteer: true, setting: "steer", opposite: true }),
  ).toBe("queue");
  expect(
    followUpDelivery({ status: working, canSteer: true, setting: undefined, opposite: true }),
  ).toBe("steer");
});

test("a provider that cannot steer always queues, even when steering is asked for", () => {
  expect(
    followUpDelivery({ status: working, canSteer: false, setting: "steer", opposite: false }),
  ).toBe("queue");
  expect(
    followUpDelivery({ status: working, canSteer: false, setting: "steer", opposite: true }),
  ).toBe("queue");
});
