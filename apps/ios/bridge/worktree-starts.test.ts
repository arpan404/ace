import { native, until } from "./test-host.ts";
import { expect, test } from "vitest";
import { WorktreeCreationProgress, type ServerMessage } from "@ace/protocol";
import { PatchPump } from "./patches.ts";
import type { DismissedSends } from "./dismissed-sends.ts";
import { WorktreeStarts, type WorktreeOwner } from "./worktree-starts.ts";

/*
 * Back to New thread on a stopped worktree start asks the daemon to forget it first, and only
 * then sets its Unsent row aside, so every failure leaves something Back can finish later: a
 * daemon that already forgot the start (`not_found`) counts as having taken it. Nothing is sent
 * while another action is on its way. The daemon's socket and the phone's store are the edges
 * stood in for: each request waits for the test's answer, and saves succeed as the test says.
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

interface Asked {
  action: string;
  answer(ok: boolean, error?: string): void;
  lose(): void;
}

/**
 * `known`: whether the daemon still has the start when the phone first asks for it.
 * `progress`: whether the phone heard how it stopped before that.
 */
function fixture(known = true, progress = true) {
  const pump = new PatchPump();
  native.ack = (accepted) => pump.ack(accepted);
  native.frames.length = 0;
  const asked: Asked[] = [];
  const listeners: ((message: ServerMessage) => void)[] = [];
  const ready = { getSnapshot: () => "ready" as const, subscribe: () => () => {} };
  const owner: WorktreeOwner = {
    request: ((message: { action: string }) =>
      new Promise<unknown>((resolve, reject) =>
        asked.push({
          action: message.action,
          answer: (ok, error) =>
            resolve({ type: "worktree.creation.result", ok, ...(error ? { error } : {}) }),
          lose: () => reject(new Error("the reply was lost")),
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
  const saving = { works: true };
  const store: DismissedSends = {
    has: (commandId) => kept.has(commandId),
    dismiss: async (commandId) => {
      if (!saving.works) return false;
      kept.add(commandId);
      return true;
    },
    restore: async (commandId) => kept.delete(commandId),
    loaded: async () => {},
    observe: () => () => {},
  };
  const starts = new WorktreeStarts(owner, pump, (text, limit) => text.slice(0, limit), store);
  if (progress)
    for (const listener of listeners)
      listener({ type: "worktree.creation.progress", ...stopped } as ServerMessage);
  starts.follow(id, { message: "Fix the export", workspaceId: "ace" });
  // The `get` a followed start asks for: answered with nothing new, or the daemon forgot it.
  const get = asked.shift();
  if (known) get?.answer(true);
  else get?.answer(false, "not_found");
  /** Only the actions Back sent, after the start was followed. */
  const actions = () => asked.map((request) => request.action);
  return { starts, asked, actions, kept, saving };
}

const latest = (type: string, key?: string) =>
  native.frames.findLast((frame) => frame.type === type && (key === undefined || frame.id === key));
type Card = {
  card: { canReturn: boolean; message: string; actions: unknown[] } | null;
  returned: boolean;
};
const card = () => latest("compose.worktree", id) as Card | undefined;
const receipt = (requestId: string) =>
  latest("receipt", requestId) as { ok: boolean; message: string } | undefined;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("Back the daemon takes sets the Unsent row aside after it, and the card goes as taken back", async () => {
  const made = fixture();
  void made.starts.giveBack(id, "back-1");
  await settle();
  expect(made.actions()).toEqual(["dismiss"]);
  // Nothing local changes until the daemon has said yes.
  expect(made.kept.has(id)).toBe(false);
  made.asked[0]?.answer(true);
  expect(await until(() => receipt("back-1"))).toMatchObject({ ok: true });
  expect(card()).toMatchObject({ card: null, returned: true });
  expect(made.kept.has(id)).toBe(true);
});

test("Back while the daemon can't be reached changes nothing on the phone and says why", async () => {
  const made = fixture();
  void made.starts.giveBack(id, "back-2");
  await settle();
  made.asked[0]?.lose();
  expect(await until(() => receipt("back-2"))).toMatchObject({
    ok: false,
    message: "Couldn't reach the daemon. Try again once connected.",
  });
  expect(card()?.returned).toBe(false);
  expect(card()?.card?.canReturn).toBe(true);
  expect(made.kept.has(id)).toBe(false);
});

test("a Back the daemon took but whose reply was lost finishes on the next Back", async () => {
  const made = fixture();
  void made.starts.giveBack(id, "back-3a");
  await settle();
  // The daemon forgot the start; its yes never reached the phone.
  made.asked[0]?.lose();
  await until(() => receipt("back-3a"));
  expect(made.kept.has(id)).toBe(false);
  void made.starts.giveBack(id, "back-3b");
  await settle();
  made.asked[1]?.answer(false, "not_found");
  expect(await until(() => receipt("back-3b"))).toMatchObject({ ok: true });
  expect(card()).toMatchObject({ card: null, returned: true });
  expect(made.kept.has(id)).toBe(true);
});

test("a Back the daemon took but this phone couldn't save keeps the card and finishes next time", async () => {
  const made = fixture();
  made.saving.works = false;
  void made.starts.giveBack(id, "back-4a");
  await settle();
  made.asked[0]?.answer(true);
  expect(await until(() => receipt("back-4a"))).toMatchObject({
    ok: false,
    message: "Couldn't save that on this phone. Your message is still here.",
  });
  // The words stay on the card, for Back again.
  expect(card()?.card).toMatchObject({ canReturn: true, message: "Fix the export" });
  made.saving.works = true;
  await made.starts.giveBack(id, "back-4b");
  // The daemon already forgot it: only the phone's step is left.
  expect(made.actions()).toEqual(["dismiss"]);
  expect(await until(() => receipt("back-4b"))).toMatchObject({ ok: true });
  expect(made.kept.has(id)).toBe(true);
});

test("a stopped start the daemon forgot while away offers only Back, which needs no daemon", async () => {
  const made = fixture(false);
  const shown = await until(() => card()?.card ?? undefined);
  expect(shown).toMatchObject({ canReturn: true, actions: [], message: "Fix the export" });
  await made.starts.giveBack(id, "back-5");
  expect(made.actions()).toEqual([]);
  expect(await until(() => receipt("back-5"))).toMatchObject({ ok: true });
  expect(made.kept.has(id)).toBe(true);
});

test("Back while Retry is still on its way sends nothing and keeps the start", async () => {
  const made = fixture();
  made.starts.act(id, "retry");
  await settle();
  // Retry's reply is held: Back arrives before the card could say Retry is running.
  await made.starts.giveBack(id, "back-6");
  expect(made.actions()).toEqual(["retry"]);
  expect(await until(() => receipt("back-6"))).toMatchObject({
    ok: false,
    message: "Another action on this worktree is still running. Try again in a moment.",
  });
  expect(card()?.returned).toBe(false);
  expect(made.kept.has(id)).toBe(false);
  made.asked[0]?.answer(true);
});

test("a start just sent that the daemon hasn't made yet shows no card and can't be given back", async () => {
  const made = fixture(false, false);
  await settle();
  expect(card()?.card ?? null).toBeNull();
  await made.starts.giveBack(id, "back-7");
  expect(await until(() => receipt("back-7"))).toMatchObject({ ok: false });
  expect(made.actions()).toEqual([]);
  expect(made.kept.has(id)).toBe(false);
});
