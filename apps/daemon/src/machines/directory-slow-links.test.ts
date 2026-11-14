import { expect, test } from "vitest";
import { MachineCallOrigin, ThreadId, type MachineCall } from "@ace/protocol";
import { RemoteProfile } from "../cli/profiles.ts";
import { MachineDirectory } from "./directory.ts";
import { MachineFailure, MachineTimeout } from "./transport.ts";

const profile = RemoteProfile.parse({
  id: "00000000-0000-4000-8000-000000000001",
  name: "studio",
  origin: "https://studio.example/",
  fingerprint: "a".repeat(64),
  deviceId: "device-studio",
  token: "b".repeat(64),
});
const origin = MachineCallOrigin.parse({
  hostId: "host-here",
  hostName: "Laptop",
  threadId: "parent",
  threadTitle: "Parent",
});
const status: MachineCall = { op: "status", threadIds: [ThreadId.parse("child")] };
const description = {
  hostId: "host-studio",
  name: "Studio",
  access: "operate",
  projects: [],
  tools: [],
  providers: ["claude"],
};

/**
 * A directory whose machine answers after `reply.ms` by the test's clock, or fails with
 * `reply.error`; each call's timeout is recorded.
 */
function directory() {
  const clock = { now: 0 };
  const reply: { ms: number; error?: unknown } = { ms: 20 };
  const timeouts: number[] = [];
  const machines = new MachineDirectory({
    profiles: () => [profile],
    now: () => clock.now,
    transport: async (_profile, body, options) => {
      timeouts.push(options.timeoutMs);
      clock.now += reply.ms;
      if (reply.error) throw reply.error;
      return body.call.op === "describe" ? description : { threads: [] };
    },
    log: () => {},
  });
  return { machines, clock, reply, timeouts };
}

test("a machine on a fast link keeps the base timeouts", async () => {
  const h = directory();
  for (let i = 0; i < 5; i++) await h.machines.call("studio", origin, status, { timeoutMs: 10_000 });
  expect(h.timeouts.at(-1)).toBe(10_000);
});

test("a machine on a slow link is given longer to answer, within bounds", async () => {
  const h = directory();
  h.reply.ms = 3000;
  for (let i = 0; i < 5; i++) await h.machines.call("studio", origin, status, { timeoutMs: 10_000 });
  const stretched = h.timeouts.at(-1) ?? 0;
  expect(stretched).toBeGreaterThan(10_000);
  expect(stretched).toBeLessThanOrEqual(50_000);
  // Work is never given a stretched timeout: only short reads are.
  await h.machines
    .call("studio", origin, { op: "cancel", threadId: ThreadId.parse("child") }, {
      timeoutMs: 15_000,
    })
    .catch(() => {});
  expect(h.timeouts.at(-1)).toBe(15_000);
});

test("a machine that answered moments ago is listed as online and slow when its describe times out", async () => {
  const h = directory();
  await expect(h.machines.list(origin)).resolves.toEqual([
    expect.objectContaining({ machine: "studio", status: "online" }),
  ]);
  await h.machines.call("studio", origin, status, { timeoutMs: 10_000 });
  h.reply.error = new MachineTimeout("offline", undefined, "Machine answer timed out");
  const [listed] = await h.machines.list(origin);
  expect(listed).toMatchObject({ status: "online", next: expect.stringContaining("slowly") });
});

test("a machine that stopped answering long ago is offline, and a timeout says the link may be slow", async () => {
  const h = directory();
  await h.machines.list(origin);
  h.clock.now += 10 * 60 * 1000;
  h.reply.error = new MachineTimeout("offline", undefined, "Machine answer timed out");
  const [listed] = await h.machines.list(origin);
  expect(listed).toMatchObject({ status: "offline", next: expect.stringContaining("slow") });
  h.reply.error = new MachineFailure("offline");
  const [unreachable] = await h.machines.list(origin);
  expect(unreachable).toMatchObject({ status: "offline", next: expect.stringContaining("wake") });
});

test("a status read that timed out says the machine is slow, not that it is unreachable", async () => {
  const h = directory();
  const timedOut = h.machines.problem(
    "studio",
    new MachineTimeout("offline", undefined, "Machine answer timed out"),
  );
  const unreachable = h.machines.problem("studio", new MachineFailure("offline"));
  expect(timedOut.detail).toContain("didn't answer in time");
  expect(unreachable.detail).toContain("offline or unreachable");
});
