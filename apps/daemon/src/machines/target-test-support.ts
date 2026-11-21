import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { Device, type MachineAgentAccess } from "@ace/protocol";
import { Store } from "../store.ts";
import { MachineGrantStore } from "./grant-store.ts";
import { GuestSessions } from "./guest-sessions.ts";
import { TargetBrowser } from "./target-browser.ts";
import { TargetThreads } from "./target-threads.ts";
import { createMachineTarget } from "./target.ts";

/* This machine serving calls from a linked laptop, over a real store: what the target tests share. */

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).toReversed()) await step();
});

export const device = Device.parse({
  id: "laptop-device",
  name: "Laptop",
  scopes: ["read", "operate"],
  createdAt: 0,
  lastSeenAt: 0,
  revokedAt: null,
});
export const origin = {
  hostId: "laptop-host",
  hostName: "Laptop",
  threadId: "parent",
  threadTitle: "Parent",
};

/** This machine serving calls from the laptop, with its agents switch as `access` says. */
export function target(access: { value: MachineAgentAccess }) {
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
  return { logs, describe, machine, threads, store };
}
