import { ThreadStore, defaultLimits } from "@ace/client";
import { afterEach, expect, test } from "vitest";
import { stopFence } from "../../../web/src/features/thread/composer/stop-target.ts";
import { harness, scriptFrames, start, end } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

test("Stop after a child-only 200-item reload stays fenced to the original root turn", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start)] },
      { on: "send", frames: [frames.frame(start)] },
    ],
    frames,
  );
  cleanups.push(h.close);
  const id = await h.create();
  h.contexts[0]?.onFrame(
    frames.frame(
      {
        type: "agent.seen",
        agent: "child",
        parent: "root",
        origin: "provider_subagent",
        fidelity: "full",
        native: { provider: "codex" },
        cwd: "/workspace",
      },
      { type: "turn.started", agent: "child", trigger: "spawn" },
      ...Array.from({ length: 205 }, (_, index) => ({
        type: "item.upsert" as const,
        agent: "child",
        item: `child-${index}`,
        draft: {
          type: "message" as const,
          role: "assistant" as const,
          complete: true,
          parts: [{ type: "text" as const, text: `Child output ${index}` }],
        },
      })),
    ),
  );
  await h.engine.flush();
  const snapshot = h.store.snapshotThread(id);
  expect(snapshot.itemOrder).toHaveLength(200);
  expect(
    Object.values(snapshot.items).every((item) => item.agentId !== snapshot.thread.rootAgentId),
  ).toBe(true);
  const reader = new ThreadStore(defaultLimits);
  reader.snapshot(snapshot);
  const fence = stopFence(reader);
  expect(fence && "runId" in fence ? fence.runId : undefined).toBe(snapshot.thread.live?.rootRunId);
  expect(fence && "runId" in fence ? fence.runId : undefined).toBeDefined();
  h.contexts[0]?.onFrame(
    frames.frame(end, { type: "turn.ended", agent: "child", outcome: "completed" }),
  );
  await h.engine.flush();
  expect(
    h.command({
      type: "thread.send",
      threadId: id,
      input: [{ type: "text", text: "New root turn" }],
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(
    h.command({ type: "thread.interrupt", threadId: id, cascade: true, ...fence }),
  ).toMatchObject({ ok: false, error: "stale_interrupt" });
  expect(h.store.getThread(id)?.status.state).toBe("working");
  expect(h.adapter.commands.filter((command) => command.type === "interrupt")).toEqual([]);
});

test("a pre-start Stop pauses its admitted input but refuses after newer work starts", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start)] }], frames);
  cleanups.push(h.close);
  const receipt = h.command({
    type: "thread.create",
    workspaceId: h.workspace,
    provider: "codex",
    input: [{ type: "text", text: "Pending startup" }],
  });
  const id = receipt.threadId;
  if (!id) throw new Error("No thread");
  const reader = new ThreadStore(defaultLimits);
  reader.snapshot(h.store.snapshotThread(id));
  const fence = stopFence(reader);
  expect(fence && "beforeSeq" in fence ? fence.beforeSeq : undefined).toBeDefined();
  expect(h.command({ type: "thread.interrupt", threadId: id, cascade: true, ...fence }).ok).toBe(
    true,
  );
  await h.engine.flush();
  expect(h.contexts).toHaveLength(0);
  expect(h.engine.queue(id).messages).toHaveLength(1);
  expect(
    h.command({ type: "queue.resume", threadId: id, expectedRevision: h.engine.queue(id).revision })
      .ok,
  ).toBe(true);
  await h.engine.flush();
  expect(
    h.command({ type: "thread.interrupt", threadId: id, cascade: true, ...fence }),
  ).toMatchObject({ ok: false, error: "stale_interrupt" });
  expect(h.store.getThread(id)?.status.state).toBe("working");
  expect(h.adapter.commands.filter((command) => command.type === "interrupt")).toEqual([]);
});
