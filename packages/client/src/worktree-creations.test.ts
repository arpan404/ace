import { expect, test } from "vitest";
import { WorktreeCreations } from "./worktree-creations.ts";

/*
 * What a worktree start's action tells its caller: taken, turned down and why, or not sent at
 * all because another action on the same start is still on its way. The daemon's socket is
 * the boundary stood in for here: each request waits until the test answers it.
 */

type Reply = { ok: boolean; error?: string };

function daemon() {
  const asked: { action: string; answer: (reply: Reply) => void; fail: () => void }[] = [];
  const listeners: ((message: unknown) => void)[] = [];
  const quiet = { getSnapshot: () => "ready" as const, subscribe: () => () => {} };
  const store = new WorktreeCreations({
    request: (message: { action: string }) =>
      new Promise((resolve, reject) =>
        asked.push({
          action: message.action,
          answer: (reply) => resolve({ type: "worktree.creation.result", ...reply }),
          fail: () => reject(new Error("socket closed")),
        }),
      ),
    onMessage: (listener: (message: unknown) => void) => {
      listeners.push(listener);
      return () => {};
    },
    connectionState: () => quiet,
    connectionGeneration: () => ({ getSnapshot: () => 1, subscribe: () => () => {} }),
  } as never);
  /** The daemon pushes progress for the create, as it does while making it. */
  const push = () =>
    listeners.forEach((listener) =>
      listener({
        type: "worktree.creation.progress",
        commandId: id,
        attempt: 1,
        state: "running",
        step: "preparing",
        startedAt: 1,
        elapsedMs: 0,
        steps: [],
        details: [],
        cleanupComplete: false,
        actions: ["cancel", "local"],
      }),
    );
  return { store, asked, push };
}

const id = "start-command-1";

test("an action asked while another is on its way is reported busy and never sent", async () => {
  const { store, asked } = daemon();
  const retry = store.act(id, "retry");
  expect(await store.act(id, "dismiss")).toBe("busy");
  expect(asked.map((request) => request.action)).toEqual(["retry"]);
  asked[0]?.answer({ ok: true });
  expect(await retry).toBe("accepted");
});

test("an action the daemon takes is accepted; one it turns down says why", async () => {
  const { store, asked } = daemon();
  const taken = store.act(id, "dismiss");
  asked[0]?.answer({ ok: true });
  expect(await taken).toBe("accepted");
  // A dismissal it took leaves the daemon without the create.
  expect(store.state(id).getSnapshot().gone).toBe(true);
  const refused = store.act(id, "dismiss");
  asked[1]?.answer({ ok: false, error: "busy" });
  expect(await refused).toBe("busy");
  expect(store.state(id).getSnapshot().refused).toBe("busy");
});

test("an action the daemon can't be asked about is reported offline", async () => {
  const { store, asked } = daemon();
  const lost = store.act(id, "dismiss");
  asked[0]?.fail();
  expect(await lost).toBe("offline");
});

test("a start the daemon no longer knows reads as gone, from its refresh or from an action", async () => {
  const { store, asked } = daemon();
  const watched = store.state(id);
  const stop = watched.subscribe(() => {});
  // Watching asks the daemon for the start, as after a reconnect.
  expect(asked.map((request) => request.action)).toEqual(["get"]);
  asked[0]?.answer({ ok: false, error: "not_found" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(watched.getSnapshot().gone).toBe(true);
  stop();
  const other = daemon();
  const lost = other.store.act(id, "dismiss");
  other.asked[0]?.answer({ ok: false, error: "not_found" });
  expect(await lost).toBe("not_found");
  expect(other.store.state(id).getSnapshot().gone).toBe(true);
});

test("a not-found answer older than progress heard since doesn't make a live create gone", async () => {
  const { store, asked, push } = daemon();
  const watched = store.state(id);
  const stop = watched.subscribe(() => {});
  // Asked before the daemon made it; the create's progress arrives before that answer.
  push();
  asked[0]?.answer({ ok: false, error: "not_found" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(watched.getSnapshot().gone).toBe(false);
  expect(watched.getSnapshot().progress?.state).toBe("running");
  stop();
});
