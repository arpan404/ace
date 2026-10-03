import { expect, test } from "vitest";
import { AgentId, Event, Thread } from "@ace/protocol";
import { createThreadView } from "@ace/projection";
import { ThreadStore, defaultLimits, oppositeFollowUpBehavior } from "./index.ts";

test("the opposite-default shortcut toggles steering and queueing", () => {
  expect(oppositeFollowUpBehavior("queue")).toBe("steer");
  expect(oppositeFollowUpBehavior("steer")).toBe("queue");
});
test("thread subscribers see a live root context meter and a queue revision independently", () => {
  const thread = Thread.parse({
    id: "thread",
    workspaceId: "workspace",
    provider: "codex",
    title: "Context",
    status: { state: "done" },
    createdAt: 0,
    updatedAt: 0,
    rootAgentId: "root",
  });
  const store = new ThreadStore(defaultLimits);
  store.snapshot(createThreadView(thread));
  const context = store.select(["context:root"], (reader) => reader.context);
  const queue = store.select(["queue"], (reader) => reader.queue);
  const changed: string[] = [];
  const stopContext = context.subscribe(() => changed.push("context")),
    stopQueue = queue.subscribe(() => changed.push("queue"));
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
          type: "context_meter.updated",
          meter: {
            agentId: AgentId.parse("root"),
            usedTokens: 12000,
            windowTokens: 128000,
            epoch: 1,
            source: "provider",
          },
        },
      }),
    ],
  });
  expect(context.getSnapshot()).toMatchObject({ usedTokens: 12000, windowTokens: 128000 });
  expect(changed).toEqual(["context"]);
  store.delivery({
    type: "events",
    subscriptionId: "thread",
    afterSeq: 1,
    throughSeq: 2,
    events: [
      Event.parse({
        id: "two",
        threadId: thread.id,
        seq: 2,
        at: 0,
        payload: {
          type: "queue.updated",
          revision: 3,
          paused: true,
          reason: "restart",
          resumeAt: null,
        },
      }),
    ],
  });
  expect(queue.getSnapshot()).toMatchObject({ revision: 3, paused: true });
  expect(changed).toEqual(["context", "queue"]);
  stopContext();
  stopQueue();
});
