/*
 * ace's own Stop of a whole thread (ADR 0052, ADR 0191): what it leaves running and what may
 * start after it. A real engine and agent control with scripted provider sessions, because a
 * Stop is the engine's interrupt, the delegation journal's fence and the provider's own
 * background work together.
 */
import { expect, test } from "vitest";
import type { Fact } from "@ace/core";
import type { ThreadId } from "@ace/protocol";
import { setup } from "./test-support.ts";

type Harness = ReturnType<typeof setup>;

/** A Claude thread whose turn is running (the scripted Claude keeps it so until stopped). */
async function working(h: Harness, key: string) {
  const planner = await h.parent();
  const workspaceId = h.store.getThread(planner.threadId)?.workspaceId;
  if (!workspaceId) throw new Error("No project");
  const created = h.service.command(key, {
    type: "thread.create",
    workspaceId,
    provider: "claude",
    access: "full-access",
    input: [{ type: "text", text: "Build it" }],
  });
  const threadId = created.threadId;
  if (!threadId) throw new Error(`Not created: ${created.error}`);
  await h.engine.flush();
  return threadId;
}

const delegateFrom = (h: Harness, threadId: ThreadId, id: string) =>
  Promise.resolve().then(() => h.delegate(h.caller(threadId), id));

test("a stopped root's turn delegates nothing more, though its next message is already accepted", async () => {
  const h = setup();
  const root = await working(h, "root");
  h.service.command("stop-root", { type: "thread.interrupt", threadId: root, cascade: true });
  await h.engine.flush();
  // The person's next message is accepted, but its turn hasn't started yet.
  h.service.command("next", {
    type: "thread.send",
    threadId: root,
    input: [{ type: "text", text: "Carry on" }],
  });
  // A tool call from the stopped turn arrives in between: still that turn's, still refused.
  await expect(delegateFrom(h, root, "late")).rejects.toMatchObject({
    code: "delegation_cancelled",
  });
  // Once the new turn runs, it delegates as any turn does.
  await h.engine.flush();
  await expect(delegateFrom(h, root, "after")).resolves.toBeDefined();
});

/** The root agent's call to ace's `delegate` for `requestId`, reported and still running. */
const delegateCall = (requestId: string): Fact => ({
  type: "item.upsert",
  agent: "root",
  item: `call-${requestId}`,
  draft: {
    type: "tool_call",
    complete: false,
    call: {
      title: "delegate",
      kind: "mcp",
      status: "running",
      detail: {
        kind: "mcp",
        server: "ace",
        tool: "delegate",
        arguments: { tasks: [{ requestId, task: "One more", role: "late" }] },
      },
    },
  },
});

test("a delegation the stopped turn had on its way is refused even once the next turn runs", async () => {
  const h = setup();
  const root = await working(h, "root");
  // The stopped turn's call to delegate is on its way when the person presses Stop.
  await h.emit(root, delegateCall("late"));
  h.service.command("stop-root", { type: "thread.interrupt", threadId: root, cascade: true });
  await h.engine.flush();
  h.service.command("next", {
    type: "thread.send",
    threadId: root,
    input: [{ type: "text", text: "Carry on" }],
  });
  await h.engine.flush();
  // The next turn runs; the old call arrives only now. It is still the stopped turn's.
  await expect(delegateFrom(h, root, "late")).rejects.toMatchObject({
    code: "delegation_cancelled",
  });
  // A call the new turn makes delegates as any turn's does.
  await expect(delegateFrom(h, root, "after")).resolves.toBeDefined();
});

test("a provider subagent still running from the stopped turn delegates nothing, before or after the next turn", async () => {
  const h = setup();
  const root = await working(h, "root");
  await h.emit(
    root,
    {
      type: "agent.seen",
      agent: "helper",
      parent: "root",
      origin: "provider_subagent",
      fidelity: "full",
      native: { provider: "claude", nativeId: "helper-native" },
      cwd: "/repo",
    },
    { type: "turn.started", agent: "helper", trigger: "spawn" },
  );
  const helper = Object.values(h.store.snapshotThread(root).agents).find(
    (agent) => agent.native.nativeId === "helper-native",
  );
  if (!helper) throw new Error("No subagent");
  const fromHelper = (id: string) =>
    Promise.resolve().then(() => h.delegate({ ...h.caller(root), agentId: helper.id }, id));
  h.service.command("stop-root", { type: "thread.interrupt", threadId: root, cascade: true });
  await h.engine.flush();
  // The Stop is still reaching the subagent: the provider reports it working, in a run of its
  // own that isn't the root's.
  await h.emit(root, { type: "turn.started", agent: "helper", trigger: "spawn" });
  await expect(fromHelper("late-helper")).rejects.toMatchObject({
    code: "delegation_cancelled",
  });
  h.clock.advance(h.clock.now() + 1_000);
  h.service.command("next", {
    type: "thread.send",
    threadId: root,
    input: [{ type: "text", text: "Carry on" }],
  });
  await h.engine.flush();
  // Its run began before the new turn: still the stopped turn's work.
  await expect(fromHelper("later-helper")).rejects.toMatchObject({
    code: "delegation_cancelled",
  });
  await expect(delegateFrom(h, root, "after")).resolves.toBeDefined();
});

test("a stopped child sent a new task delegates again once that task's turn runs, not before", async () => {
  const h = setup();
  const root = await working(h, "root");
  const child = await h.delegate(h.caller(root), "child");
  const childId = child.childId;
  await h.engine.flush();
  h.service.command("stop-child", { type: "thread.interrupt", threadId: childId, cascade: true });
  await h.engine.flush();
  await expect
    .poll(() => h.service.journal.get(childId)?.phase, { timeout: 15_000 })
    .toBe("settled");
  h.service.command("new-task", {
    type: "thread.send",
    threadId: childId,
    input: [{ type: "text", text: "Now the docs" }],
  });
  await expect(delegateFrom(h, childId, "late")).rejects.toMatchObject({
    code: "delegation_cancelled",
  });
  await h.engine.flush();
  await expect(delegateFrom(h, childId, "after")).resolves.toBeDefined();
});

test.each([
  ["no agent named", false],
  ["the root agent named by its id", true],
])(
  "a Stop of the whole thread with %s stops the agent's background shells too",
  async (_name, naming) => {
    const h = setup();
    const threadId = await working(h, "claude-thread");
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
    const rootAgentId = h.store.getThread(threadId)?.rootAgentId;
    const stopped = h.service.command("stop-it", {
      type: "thread.interrupt",
      threadId,
      cascade: true,
      ...(naming && rootAgentId ? { agentId: rootAgentId } : {}),
    });
    expect(stopped).toMatchObject({ ok: true });
    await h.engine.flush();
    await expect.poll(running, { timeout: 15_000 }).toBe(0);
    expect(h.stoppedTasks).toEqual(["watch"]);
  },
);
