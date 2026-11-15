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
    onMessage: () => () => {},
    connectionState: () => quiet,
    connectionGeneration: () => ({ getSnapshot: () => 1, subscribe: () => () => {} }),
  } as never);
  return { store, asked };
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
