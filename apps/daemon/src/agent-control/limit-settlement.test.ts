import { expect, test } from "vitest";
import { limitSettles } from "./limit-settlement.ts";
import type { ThreadStatus } from "@ace/protocol";

test.each([
  {
    name: "stopped limit",
    status: { state: "limited" },
    stopped: true,
    resuming: false,
    descendantsPending: false,
    settles: true,
  },
  {
    name: "provider still retrying",
    status: { state: "limited" },
    stopped: false,
    resuming: false,
    descendantsPending: false,
    settles: false,
  },
  {
    name: "resume in flight",
    status: { state: "limited" },
    stopped: true,
    resuming: true,
    descendantsPending: false,
    settles: false,
  },
  {
    name: "live descendants",
    status: { state: "limited" },
    stopped: true,
    resuming: false,
    descendantsPending: true,
    settles: false,
  },
  {
    name: "human request",
    status: { state: "needs_you", interactions: 1 },
    stopped: true,
    resuming: false,
    descendantsPending: false,
    settles: false,
  },
] satisfies {
  name: string;
  status: ThreadStatus;
  stopped: boolean;
  resuming: boolean;
  descendantsPending: boolean;
  settles: boolean;
}[])("$name settles only when all work stopped", ({ status, settles, ...facts }) => {
  expect(limitSettles(status, facts)).toBe(settles);
});
