import { expect, test } from "vitest";
import { MachineCallOrigin, ThreadId, type MachineCall } from "@ace/protocol";
import { RemoteProfile } from "../cli/profiles.ts";
import { MachineDirectory } from "./directory.ts";
import { MachineFailure } from "./transport.ts";

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

function directory() {
  const logs: string[] = [];
  const reply: { error?: unknown } = {};
  const machines = new MachineDirectory({
    profiles: () => [profile],
    transport: async () => {
      if (reply.error) throw reply.error;
      return { threads: [] };
    },
    log: (message) => {
      logs.push(message);
    },
  });
  const poll = () => machines.call("studio", origin, status, { timeoutMs: 100 }).catch(() => {});
  return { machines, logs, reply, poll };
}

test("status polls that succeed write no line per call", async () => {
  const h = directory();
  for (let call = 0; call < 5; call++) await h.poll();
  expect(h.logs).toEqual([]);
});

test("a machine that keeps failing status polls is logged when it starts failing and when it answers again", async () => {
  const h = directory();
  h.reply.error = new MachineFailure("offline");
  for (let call = 0; call < 5; call++) await h.poll();
  expect(h.logs).toEqual(["Machine call to another device failed"]);
  h.reply.error = undefined;
  await h.poll();
  await h.poll();
  expect(h.logs).toEqual([
    "Machine call to another device failed",
    "Machine calls to another device work again",
  ]);
});

test("a failing machine that starts refusing instead is logged again, as the failure changed", async () => {
  const h = directory();
  h.reply.error = new MachineFailure("offline");
  await h.poll();
  await h.poll();
  h.reply.error = new MachineFailure("refused", "machine_opted_out", "Turned off.");
  await h.poll();
  await h.poll();
  expect(h.logs).toEqual([
    "Machine call to another device failed",
    "Machine call to another device failed",
  ]);
});

test("one routine read failing while another is refused is logged once each, never on every call", async () => {
  const logs: string[] = [];
  const machines = new MachineDirectory({
    profiles: () => [profile],
    transport: async (_profile, body) => {
      if (body.call.op === "status") throw new MachineFailure("offline");
      throw new MachineFailure("refused", "machine_opted_out", "Turned off.");
    },
    log: (message) => {
      logs.push(message);
    },
  });
  for (let round = 0; round < 5; round++) {
    await machines.call("studio", origin, status, { timeoutMs: 100 }).catch(() => {});
    await machines.call("studio", origin, { op: "describe" }, { timeoutMs: 100 }).catch(() => {});
  }
  expect(logs).toEqual([
    "Machine call to another device failed",
    "Machine call to another device failed",
  ]);
});
