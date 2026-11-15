import { native, until } from "./test-host.ts";
import { expect, test } from "vitest";
import { WorktreeCreationProgress, type ServerMessage } from "@ace/protocol";
import { PatchPump } from "./patches.ts";
import type { DismissedSends } from "./dismissed-sends.ts";
import { WorktreeStarts, type WorktreeOwner } from "./worktree-starts.ts";

/*
 * Back to New thread on a stopped worktree start gives the words back only once the phone has
 * saved that the start's Unsent row is dealt with and the daemon has forgotten the start. Either
 * one failing, or another action still on its way, leaves the card (and its row) and says why.
 * The daemon's socket and the phone's store are the edges stood in for: each request waits for
 * the test's answer, and the store's saves succeed or fail as the test says.
 */

const id = "start-command-back";
const stopped = WorktreeCreationProgress.parse({
  commandId: id,
  attempt: 1,
  state: "cancelled",
  step: "creating",
  startedAt: 1,
  elapsedMs: 10,
  steps: [{ step: "preparing", startedAt: 1, elapsedMs: 5 }],
  details: [],
  cleanupComplete: true,
  actions: ["retry", "local"],
});

function fixture(options: { saves?: boolean } = {}) {
  const pump = new PatchPump();
  native.ack = (accepted) => pump.ack(accepted);
  native.frames.length = 0;
  const asked: { action: string; answer(ok: boolean): void; lose(): void }[] = [];
  const listeners: ((message: ServerMessage) => void)[] = [];
  const ready = { getSnapshot: () => "ready" as const, subscribe: () => () => {} };
  const owner: WorktreeOwner = {
    request: ((message: { action: string }) =>
      new Promise<unknown>((resolve, reject) =>
        asked.push({
          action: message.action,
          answer: (ok) =>
            resolve({ type: "worktree.creation.result", ok, ...(ok ? {} : { error: "busy" }) }),
          lose: () => reject(new Error("socket closed")),
        }),
      )) as WorktreeOwner["request"],
    onMessage: (listener) => {
      listeners.push(listener);
      return () => {};
    },
    connectionState: () => ready as ReturnType<WorktreeOwner["connectionState"]>,
    connectionGeneration: () => ({ getSnapshot: () => 1, subscribe: () => () => {} }),
    pendingSends: () => ({ getSnapshot: () => [], subscribe: () => () => {} }),
  };
  const kept = new Set<string>();
  const store: DismissedSends = {
    has: (commandId) => kept.has(commandId),
    dismiss: async (commandId) => {
      if (options.saves === false) return false;
      kept.add(commandId);
      return true;
    },
    restore: async (commandId) => kept.delete(commandId),
    loaded: async () => {},
    observe: () => () => {},
  };
  const starts = new WorktreeStarts(owner, pump, (text, limit) => text.slice(0, limit), store);
  starts.follow(id, { message: "Fix the export", workspaceId: "ace" });
  // The `get` a followed start asks for, answered with nothing new.
  asked.shift()?.answer(true);
  for (const listener of listeners)
    listener({ type: "worktree.creation.progress", ...stopped } as ServerMessage);
  const card = () =>
    latest("compose.worktree", id) as { card: unknown; returned: boolean } | undefined;
  return { starts, asked, kept, card, receipt };
}

const latest = (type: string, key?: string) =>
  native.frames.findLast((frame) => frame.type === type && (key === undefined || frame.id === key));

const receipt = (requestId: string) =>
  latest("receipt", requestId) as { ok: boolean; message: string } | undefined;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("Back that the phone saves and the daemon takes closes the card as taken back", async () => {
  const made = fixture();
  void made.starts.giveBack(id, "back-1");
  await settle();
  expect(made.asked.map((request) => request.action)).toEqual(["dismiss"]);
  made.asked[0]?.answer(true);
  expect(await until(() => made.receipt("back-1"))).toMatchObject({ ok: true });
  expect(made.card()).toMatchObject({ card: null, returned: true });
  expect(made.kept.has(id)).toBe(true);
});

test("Back while the daemon can't be reached keeps the card and its Unsent row, and says why", async () => {
  const made = fixture();
  void made.starts.giveBack(id, "back-2");
  await settle();
  made.asked[0]?.lose();
  expect(await until(() => made.receipt("back-2"))).toMatchObject({
    ok: false,
    message: "Couldn't reach the daemon. Try again once connected.",
  });
  expect(made.card()?.returned).toBe(false);
  expect(made.card()?.card).not.toBeNull();
  // The row it hid while asking comes back.
  expect(made.kept.has(id)).toBe(false);
});

test("Back that can't be saved on this phone never asks the daemon and keeps the card", async () => {
  const made = fixture({ saves: false });
  await made.starts.giveBack(id, "back-3");
  expect(made.asked).toHaveLength(0);
  expect(await until(() => made.receipt("back-3"))).toMatchObject({
    ok: false,
    message: "Couldn't save that on this phone. Your message is still here.",
  });
  expect(made.card()?.returned).toBe(false);
});

test("Back while Retry is still on its way sends nothing and keeps the start", async () => {
  const made = fixture();
  made.starts.act(id, "retry");
  await settle();
  // Retry's reply is held: Back arrives before the card could say Retry is running.
  await made.starts.giveBack(id, "back-4");
  expect(made.asked.map((request) => request.action)).toEqual(["retry"]);
  expect(await until(() => made.receipt("back-4"))).toMatchObject({
    ok: false,
    message: "Another action on this worktree is still running. Try again in a moment.",
  });
  expect(made.card()?.returned).toBe(false);
  expect(made.kept.has(id)).toBe(false);
  made.asked[0]?.answer(true);
});
