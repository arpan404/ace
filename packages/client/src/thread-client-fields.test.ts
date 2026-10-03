import { expect, test } from "vitest";
import { Event, Thread } from "@ace/protocol";
import { createThreadView } from "@ace/projection";
import { ThreadStore, defaultLimits } from "./index.ts";

test("a thread's checkout details reach thread subscribers when the daemon refreshes them", () => {
  const thread = Thread.parse({
    id: "thread",
    workspaceId: "workspace",
    provider: "codex",
    title: "Checkout",
    status: { state: "done" },
    createdAt: 0,
    updatedAt: 0,
  });
  const store = new ThreadStore(defaultLimits);
  store.snapshot(createThreadView(thread));
  const branch = store.select(["thread"], (reader) => reader.thread?.details?.branch);
  const seen: (string | null | undefined)[] = [];
  const stop = branch.subscribe(() => seen.push(branch.getSnapshot()));
  store.delivery({
    type: "events",
    subscriptionId: "thread",
    afterSeq: 0,
    throughSeq: 1,
    events: [
      Event.parse({
        id: "one",
        threadId: thread.id,
        seq: 1,
        at: 0,
        payload: {
          type: "thread.client.updated",
          changes: { details: { branch: "fix/replay", ahead: 1 } },
        },
      }),
    ],
  });
  stop();
  expect(branch.getSnapshot()).toBe("fix/replay");
  expect(seen).toEqual(["fix/replay"]);
});
