import { expect, test } from "vitest";
import type { ThreadStatus } from "@ace/protocol";
import { followUpDelivery, waitingDelivery } from "./follow-up.ts";

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

test("while the root only waits on its subagents a message goes in now, whatever the setting", () => {
  // Its turn over: a steer starts the next turn at once, whether or not the provider can steer.
  expect(waitingDelivery({ canSteer: false, turnOver: true, opposite: false })).toBe("steer");
  expect(waitingDelivery({ canSteer: true, turnOver: true, opposite: false })).toBe("steer");
  // Waiting inside its turn: a steering provider takes it now, any other only at the turn's end.
  expect(waitingDelivery({ canSteer: true, turnOver: false, opposite: false })).toBe("steer");
  expect(waitingDelivery({ canSteer: false, turnOver: false, opposite: false })).toBe("queue");
  // The modified send still queues it.
  expect(waitingDelivery({ canSteer: true, turnOver: true, opposite: true })).toBe("queue");
});
