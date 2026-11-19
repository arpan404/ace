/*
 * ace's own Stop of a whole thread (ADR 0052, ADR 0191): what it leaves running. A real engine and
 * agent control with scripted provider sessions, because a Stop is the engine's interrupt, the
 * delegation journal's fence and the provider's own background work together.
 */
import { expect, test } from "vitest";
import { setup } from "./test-support.ts";

test("a stopped thread delegates nothing more, though its stopping turn still asks", async () => {
  const h = setup();
  const root = await h.parent();
  const stop = h.service.command("stop-root", {
    type: "thread.interrupt",
    threadId: root.threadId,
    cascade: true,
  });
  expect(stop).toMatchObject({ ok: true });
  await h.engine.flush();
  // A tool call the stopping turn made before it ended arrives now.
  await expect(Promise.resolve().then(() => h.delegate(root, "late-child"))).rejects.toMatchObject({
    code: "delegation_cancelled",
  });
  expect(h.service.journal.children(root.threadId)).toEqual([]);
});

test("a stopped thread delegates again once the person speaks to it", async () => {
  const h = setup();
  const root = await h.parent();
  h.service.command("stop-root", {
    type: "thread.interrupt",
    threadId: root.threadId,
    cascade: true,
  });
  await h.engine.flush();
  h.service.command("carry-on", {
    type: "thread.send",
    threadId: root.threadId,
    input: [{ type: "text", text: "Carry on" }],
  });
  await h.engine.flush();
  await expect(
    Promise.resolve().then(() => h.delegate(root, "after-resume")),
  ).resolves.toBeDefined();
});

test("a Stop of the whole thread stops the agent's background shells too", async () => {
  const h = setup();
  const planner = await h.parent();
  const workspaceId = h.store.getThread(planner.threadId)?.workspaceId;
  if (!workspaceId) throw new Error("No project");
  // A Claude turn, whose interrupt ends the turn and leaves its background work running.
  const created = h.service.command("claude-thread", {
    type: "thread.create",
    workspaceId,
    provider: "claude",
    access: "full-access",
    input: [{ type: "text", text: "Build it" }],
  });
  const threadId = created.threadId;
  if (!threadId) throw new Error(`Not created: ${created.error}`);
  await h.engine.flush();
  await h.emit(threadId, {
    type: "background.started",
    agent: "root",
    task: "watch",
    kind: "shell",
    title: "bun run build --watch",
    stoppable: true,
  });
  const running = () => h.store.getThread(threadId)?.live?.backgroundTaskCount ?? 0;
  expect(running()).toBe(1);
  const stopped = h.service.command("stop-it", {
    type: "thread.interrupt",
    threadId,
    cascade: true,
  });
  expect(stopped).toMatchObject({ ok: true });
  await h.engine.flush();
  await expect.poll(running, { timeout: 15_000 }).toBe(0);
  expect(h.stoppedTasks).toEqual(["watch"]);
});
