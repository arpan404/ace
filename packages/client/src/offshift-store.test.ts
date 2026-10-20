import { expect, test } from "vitest";
import { Event, Thread } from "@ace/protocol";
import { createThreadView } from "@ace/projection";
import { ThreadStore, defaultLimits } from "./index.ts";

test("an Offshift change reaches the offshift selection alone and survives export", () => {
  const thread = Thread.parse({
    id: "thread",
    workspaceId: "workspace",
    provider: "codex",
    title: "Offshift",
    status: { state: "done" },
    createdAt: 0,
    updatedAt: 0,
  });
  const store = new ThreadStore(defaultLimits);
  store.snapshot(createThreadView(thread));
  const offshift = store.select(["offshift"], (reader) => reader.offshift);
  const queue = store.select(["queue"], (reader) => reader.queue);
  const changed: string[] = [];
  offshift.subscribe(() => changed.push("offshift"));
  queue.subscribe(() => changed.push("queue"));
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
          type: "offshift.updated",
          card: {
            id: "login",
            outcome: "Login shows an error",
            outcomeTruncated: false,
            endpoint: "Local change",
            phase: "implement",
            blocker: "Need a test account",
            version: 2,
            updatedAt: 5,
            revision: "r1",
            criteria: [],
            criteriaCount: 1,
            pending: [],
            pendingCount: 0,
          },
        },
      }),
    ],
  });
  expect(offshift.getSnapshot()).toMatchObject({ id: "login", blocker: "Need a test account" });
  expect(changed).toEqual(["offshift"]);
  expect(store.export().view?.offshift).toMatchObject({ id: "login", version: 2 });
});
