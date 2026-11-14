import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Device, type MachineAgentAccess } from "@ace/protocol";
import { Store } from "../store.ts";
import { MachineGrantStore } from "./grant-store.ts";
import { GuestSessions } from "./guest-sessions.ts";
import { TargetBrowser } from "./target-browser.ts";
import { TargetThreads } from "./target-threads.ts";
import { createMachineTarget } from "./target.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).toReversed()) await step();
});

const device = Device.parse({
  id: "laptop-device",
  name: "Laptop",
  scopes: ["read", "operate"],
  createdAt: 0,
  lastSeenAt: 0,
  revokedAt: null,
});
const origin = {
  hostId: "laptop-host",
  hostName: "Laptop",
  threadId: "parent",
  threadTitle: "Parent",
};

/** This machine serving calls from the laptop, with its agents switch as `access` says. */
function target(access: { value: MachineAgentAccess }) {
  const dir = mkdtempSync(join(tmpdir(), "ace-target-logs-"));
  const store = new Store(join(dir, "events.sqlite"));
  cleanup.push(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const threads = new TargetThreads({
    store,
    engine: () => undefined,
    journal: () => undefined,
    now: () => 0,
    limit: () => undefined,
    schedule: () => () => {},
    report: () => {},
  });
  cleanup.push(() => threads.close());
  const guests = new GuestSessions({
    store,
    engine: () => undefined,
    threads,
    chat: () => Promise.reject(new Error("No chats here")),
    newId: () => "id",
    remove: () => Promise.resolve(),
  });
  const grants = new MachineGrantStore(store, () => 0);
  grants.set(device.id, "agents", "operate");
  const logs: string[] = [];
  const machine = createMachineTarget({
    hostId: "desk-host",
    hostName: async () => "Desk",
    access: async () => access.value,
    engine: () => undefined,
    threads,
    browser: new TargetBrowser({ store, browser: () => undefined, guests }),
    guests,
    grants,
    hosts: {},
    commandJobs: () => ({ jobs: [] }),
    spade: () => undefined,
    inboxKey: () => "k".repeat(64),
    now: () => 1_000,
    log: (message) => {
      logs.push(message);
    },
  });
  const describe = () =>
    machine.handle(device, { origin, call: { op: "describe" } }, new AbortController().signal);
  return { logs, describe };
}

test("routine reads another machine repeats that are served write no line per call", async () => {
  const h = target({ value: "operate" });
  for (let call = 0; call < 5; call++) expect((await h.describe()).status).toBe(200);
  expect(h.logs).toEqual([]);
});

test("routine reads refused in a row are logged once, and again when they are served", async () => {
  const access: { value: MachineAgentAccess } = { value: "off" };
  const h = target(access);
  for (let call = 0; call < 5; call++) expect((await h.describe()).status).not.toBe(200);
  expect(h.logs).toEqual(["Machine call from another device refused"]);
  access.value = "operate";
  await h.describe();
  await h.describe();
  expect(h.logs).toEqual([
    "Machine call from another device refused",
    "Machine call from another device served again",
  ]);
});
