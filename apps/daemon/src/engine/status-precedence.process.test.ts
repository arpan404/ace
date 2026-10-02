import { afterEach, expect, test } from "vitest";
import type { ThreadStatus } from "@ace/protocol";
import { harness, scriptFrames, start, end, task, question, until } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

test("clients see human requests ahead of active background children and queued input waits for the whole tree", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      {
        on: "send",
        frames: [
          frames.frame(
            start,
            {
              type: "agent.seen",
              agent: "child",
              parent: "root",
              background: true,
              origin: "provider_subagent",
              fidelity: "full",
              native: { provider: "codex", nativeId: "child" },
              cwd: "/repo",
            },
            { type: "turn.started", agent: "child", nativeTurnId: "child-turn", trigger: "spawn" },
            task,
            end,
          ),
        ],
      },
      {
        on: "send",
        frames: [
          frames.frame({ ...start, nativeTurnId: "queued" }, { ...end, nativeTurnId: "queued" }),
        ],
      },
    ],
    frames,
  );
  cleanups.push(h.close);
  const id = await h.create();
  const context = h.contexts[0];
  if (!context) throw new Error("Missing provider");
  const client = await h.connect("status-reader");
  client.send({
    type: "subscribe",
    subscriptionId: "tree",
    scope: { kind: "thread", threadId: id },
  });
  const snapshot = await until(client, (message) => message.type === "snapshot");
  expect(snapshot).toMatchObject({
    view: { kind: "thread", thread: { status: { state: "working" } } },
  });
  expect(h.store.getThread(id)?.status.state).toBe("working");
  expect(
    h.command({
      type: "thread.send",
      threadId: id,
      delivery: "queue",
      input: [{ type: "text", text: "next" }],
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(h.adapter.commands.filter((command) => command.type === "send")).toHaveLength(1);
  expect(h.store.getThread(id)?.status.state).toBe("working");

  async function status(expected: ThreadStatus) {
    const delivery = await until(
      client,
      (message) =>
        message.type === "events" &&
        message.events.some(
          (event) =>
            event.payload.type === "thread.updated" &&
            event.payload.status?.state === expected.state,
        ),
    );
    if (delivery.type !== "events") throw new Error("Missing status delivery");
    const statusEvent = delivery.events.find(
      (event) =>
        event.payload.type === "thread.updated" && event.payload.status?.state === expected.state,
    );
    if (statusEvent?.payload.type !== "thread.updated") throw new Error("Missing thread status");
    expect(statusEvent.payload.status).toEqual(expected);
    expect(h.store.getThread(id)?.status).toEqual(expected);
  }

  context.onFrame(frames.frame(question));
  await h.engine.flush();
  await status({ state: "needs_you", interactions: 1 });
  context.onFrame(
    frames.frame({ type: "interaction.closed", interaction: "approval", state: "cancelled" }),
  );
  await h.engine.flush();
  await status({ state: "working", agents: 1 });

  context.onFrame(
    frames.frame({
      type: "turn.ended",
      agent: "child",
      nativeTurnId: "child-turn",
      outcome: "completed",
    }),
  );
  await h.engine.flush();
  await status({ state: "waiting", on: "background_task" });
  expect(h.store.getThread(id)?.status).toEqual({ state: "waiting", on: "background_task" });
  expect(h.adapter.commands.filter((command) => command.type === "send")).toHaveLength(1);

  context.onFrame(frames.frame({ type: "background.ended", task: "shell", status: "completed" }));
  await h.engine.flush();
  await status({ state: "done" });
  expect(h.adapter.commands.filter((command) => command.type === "send")).toHaveLength(2);
  expect(h.errors).toEqual([]);
});
