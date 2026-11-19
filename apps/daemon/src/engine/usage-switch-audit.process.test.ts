import { afterEach, expect, test } from "vitest";
import { transitionHarness } from "./transition-test-support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

test("a usage-limit escape can switch providers while a background shell remains", async () => {
  const h = transitionHarness({ limited: true, recovery: { resetAt: () => 5000 } });
  cleanup.push(h.close);
  const id = await h.create();
  h.emit(id, {
    type: "background.started",
    agent: "root",
    task: "build",
    kind: "shell",
    title: "Build",
    stoppable: true,
  });
  await h.engine.flush();
  expect(
    h.command({ type: "thread.switch", threadId: id, selection: { provider: "claude" } }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(h.store.getThread(id)?.switch?.state).toBe("applied");
});

test("a usage-limit escape can switch providers when its only child has hit a limit", async () => {
  const h = transitionHarness({ recovery: { resetAt: () => 5000 } });
  cleanup.push(h.close);
  const id = await h.create();
  h.emit(
    id,
    {
      type: "agent.seen",
      agent: "child",
      parent: "root",
      origin: "provider_subagent",
      cwd: h.home,
      fidelity: "full",
      native: { provider: "codex", nativeId: "child-native" },
    },
    { type: "turn.started", agent: "child", nativeTurnId: "child-turn", trigger: "user" },
    {
      type: "turn.ended",
      agent: "child",
      outcome: "failed",
      nativeTurnId: "child-turn",
      error: { kind: "quota", message: "Quota exhausted" },
    },
    { type: "retry", agent: "child", on: "rate_limit", until: 5000 },
  );
  await h.engine.flush();
  expect(h.engine.queue(id).reason).not.toBe("limit");
  expect(h.engine.queue(id).resumeAt).toBeNull();
  expect(
    h.command({ type: "thread.switch", threadId: id, selection: { provider: "claude" } }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(h.store.getThread(id)?.switch?.state).toBe("applied");
});

test("switching providers does not expose the old provider quota error as the destination failure", async () => {
  const h = transitionHarness({ recovery: { resetAt: () => 5000 } });
  cleanup.push(h.close);
  const id = await h.create();
  h.emit(
    id,
    { type: "turn.started", agent: "root", nativeTurnId: "quota-turn", trigger: "user" },
    {
      type: "turn.ended",
      agent: "root",
      nativeTurnId: "quota-turn",
      outcome: "failed",
      error: { kind: "quota", code: "rate_limit", message: "Source provider allowance exhausted" },
    },
    { type: "retry", agent: "root", on: "rate_limit", until: 5000 },
  );
  await h.engine.flush();
  h.command({ type: "thread.switch", threadId: id, selection: { provider: "claude" } });
  await h.engine.flush();
  expect(h.store.getThread(id)?.switch?.state).toBe("applied");
  const snapshot = h.store.snapshotThread(id);
  const root = Object.values(snapshot.agents).find(
    (agent) => agent.id === snapshot.thread.rootAgentId,
  );
  expect(root?.status).not.toMatchObject({ state: "failed", error: { kind: "quota" } });
});

test("a remaining source-provider child limit is not labeled as the destination provider's quota", async () => {
  const { queueNotice, heldTurn } = await import("@ace/ui-core");
  const h = transitionHarness({ limited: true, recovery: { resetAt: () => 5000 } });
  cleanup.push(h.close);
  const id = await h.create();
  h.command({ type: "thread.switch", threadId: id, selection: { provider: "claude" } });
  await h.engine.flush();
  expect(h.store.getThread(id)?.switch?.state).toBe("applied");
  // Independent child threads keep reporting after the root changes provider.
  const childId = await h.create();
  const child = h.store.getThread(childId);
  const parent = h.store.getThread(id)?.rootAgentId;
  if (!child || !parent) throw new Error("Missing test threads");
  h.engine.attachChild(id, parent, child, "worker", false);
  await h.engine.flush();
  const thread = h.store.getThread(id);
  expect(thread?.provider).toBe("claude");
  const notice = queueNotice(thread?.status, h.engine.queue(id), h.clock.now());
  const turn = heldTurn(notice, undefined, "Claude Code", h.clock.now());
  expect(turn?.lead).not.toBe("Claude Code is out of usage");
});
