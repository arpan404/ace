import { expect, it } from "vitest";
import { ThreadId } from "@ace/protocol";
import { orgSocketPolicy } from "./socket-wiring.ts";
import { structuralTrees } from "./trees.ts";

// ADR 0209 §4.2: a command queued while the machine was a person's carries no lasting allow. If
// the machine is enrolled before its lane runs it, it is decided again there, and refused.

it("a command queued before enrollment is refused once the machine is an org host", () => {
  let org: string | undefined;
  const policy = orgSocketPolicy({
    org: () => org,
    facts: () => ({ hostToken: true }),
    trees: structuralTrees(() => undefined),
    fail: () => {},
    send: () => {},
  });
  const send = {
    type: "command",
    command: {
      id: "cmd_1",
      deviceId: "device",
      payload: { type: "thread.send", threadId: ThreadId.parse("t_1"), input: [] },
    },
  };
  const later = policy.recheck(send);
  expect(later()).toBe(true);
  org = "org_acme";
  expect(later()).toBe(false);
});

it("on a person's machine a queued command stays allowed, as before", () => {
  const policy = orgSocketPolicy({
    org: () => undefined,
    facts: () => ({ hostToken: true }),
    trees: structuralTrees(() => undefined),
    fail: () => {},
    send: () => {},
  });
  expect(policy.recheck({ type: "command" })()).toBe(true);
});
