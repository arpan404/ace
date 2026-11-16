import { expect, it } from "vitest";
import { builtinSkillLeaseUnused, type SkillProcessRuntime } from "./builtin-skill-processes.ts";

const owner = { pid: 100, group: 100, start: "1", uid: 501 };
const provider = { pid: 200, group: 200, start: "2", uid: 501 };
const lease = JSON.stringify({
  version: 1,
  owner,
  processes: [provider],
  launching: false,
  closed: true,
});
const denied = () => {
  throw Object.assign(new Error("Operation not permitted"), { code: "EPERM" });
};

it("retains projections quietly when a recorded PID or group is inaccessible", () => {
  const runtime: SkillProcessRuntime = { ownerPid: 300, identity: denied, groupGone: () => true };
  expect(builtinSkillLeaseUnused(lease, runtime)).toBe(false);
  expect(
    builtinSkillLeaseUnused(lease, { ...runtime, identity: () => undefined, groupGone: denied }),
  ).toBe(false);
});

it("only reclaims a projection after the recorded process and its group are gone", () => {
  const runtime: SkillProcessRuntime = {
    ownerPid: 300,
    identity: () => undefined,
    groupGone: () => true,
  };
  expect(builtinSkillLeaseUnused(lease, runtime)).toBe(true);
  expect(
    builtinSkillLeaseUnused(lease, {
      ...runtime,
      identity: () => ({ ...provider, start: "reused" }),
      groupGone: () => false,
    }),
  ).toBe(false);
});
