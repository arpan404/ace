import { expect, test } from "vitest";
import type { LockedUseStatus, ServerMessage } from "@ace/protocol";
import { subscribeLockedUse, type LockedUseOwner } from "./locked-use-subscription.ts";
import type { ConnectionState } from "./types.ts";

interface Pending {
  input: { type: string; subscriptionId?: string };
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/** A connection whose replies and pushes the test hands out by hand. */
function connection() {
  let state: ConnectionState = "ready";
  const requests: Pending[] = [];
  const listeners = new Set<(message: ServerMessage) => void>();
  const watchers = new Set<() => void>();
  const owner = {
    get state() {
      return state;
    },
    connectionState: () => ({
      getSnapshot: () => state,
      subscribe(listener: () => void) {
        watchers.add(listener);
        return () => watchers.delete(listener);
      },
    }),
    request: (input: Pending["input"]) =>
      new Promise((resolve, reject) => requests.push({ input, resolve, reject })),
    onMessage(listener: (message: ServerMessage) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as LockedUseOwner;
  return {
    owner,
    requests,
    push(revision: number, status: LockedUseStatus) {
      for (const listener of listeners)
        listener({ type: "lockedUse.changed", subscriptionId: "mac", revision, status });
    },
    reply(index: number, revision: number, status: LockedUseStatus) {
      requests[index]?.resolve({
        type: "lockedUse.status",
        requestId: "r",
        subscriptionId: "mac",
        revision,
        status,
      });
    },
    setState(next: ConnectionState) {
      state = next;
      for (const watcher of watchers) watcher();
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const timers = () => {
  const due: (() => void)[] = [];
  return { due, set: (_delay: number, run: () => void) => (due.push(run), () => {}) };
};

test("a push that beats the snapshot is delivered once, and the older snapshot is dropped", async () => {
  const wire = connection();
  const seen: LockedUseStatus[] = [];
  subscribeLockedUse(
    wire.owner,
    "mac",
    (status) => seen.push(status),
    () => {},
    timers(),
  );
  wire.push(2, { state: "on" });
  wire.reply(0, 2, { state: "on" });
  await settle();
  wire.push(3, { state: "driftRepairNeeded", reason: "Replaced" });
  wire.push(3, { state: "driftRepairNeeded", reason: "Replaced" });
  expect(seen).toEqual([{ state: "on" }, { state: "driftRepairNeeded", reason: "Replaced" }]);
});

test("a snapshot older than a delivered push never replaces it", async () => {
  const wire = connection();
  const seen: LockedUseStatus[] = [];
  subscribeLockedUse(
    wire.owner,
    "mac",
    (status) => seen.push(status),
    () => {},
    timers(),
  );
  wire.push(5, { state: "off" });
  wire.reply(0, 4, { state: "on" });
  await settle();
  expect(seen).toEqual([{ state: "off" }]);
});

test("a failed subscribe renews under the same id and takes the fresh snapshot", async () => {
  const wire = connection();
  const seen: LockedUseStatus[] = [];
  let failures = 0;
  const retry = timers();
  subscribeLockedUse(
    wire.owner,
    "mac",
    (status) => seen.push(status),
    () => failures++,
    retry,
  );
  wire.requests[0]?.reject(new Error("timeout"));
  await settle();
  expect(failures).toBe(1);
  retry.due[0]?.();
  expect(wire.requests[1]?.input).toEqual({ type: "lockedUse.subscribe", subscriptionId: "mac" });
  wire.reply(1, 1, { state: "needsApproval" });
  await settle();
  expect(seen).toEqual([{ state: "needsApproval" }]);
});

test("after a reconnect, a restarted daemon's lower revisions are delivered again", async () => {
  const wire = connection();
  const seen: LockedUseStatus[] = [];
  subscribeLockedUse(
    wire.owner,
    "mac",
    (status) => seen.push(status),
    () => {},
    timers(),
  );
  wire.reply(0, 9, { state: "on" });
  await settle();
  wire.setState("reconnecting");
  wire.setState("ready");
  wire.reply(1, 0, { state: "off" });
  await settle();
  expect(seen).toEqual([{ state: "on" }, { state: "off" }]);
});
