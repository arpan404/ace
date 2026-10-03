import { afterEach, expect, test } from "vitest";
import { transitionHarness } from "./transition-test-support.ts";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
function setup(options: Parameters<typeof transitionHarness>[0] = {}) {
  const h = transitionHarness(options);
  cleanup.push(h.close);
  return h;
}
function follow(h: ReturnType<typeof setup>, threadId: Awaited<ReturnType<typeof h.create>>) {
  expect(
    h.command({
      type: "thread.send",
      threadId,
      input: [{ type: "text", text: "follow up" }],
      delivery: "queue",
    }).ok,
  ).toBe(true);
}
test("queued switch waits for the turn and its background work without interrupting it", async () => {
  const h = setup();
  const id = await h.create();
  h.held.add(id);
  follow(h, id);
  await h.engine.flush();
  const sourceSession = h.sessions.at(-1);
  expect(
    h.command({
      type: "thread.switch",
      threadId: id,
      selection: { provider: "claude", model: "model-b" },
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(h.store.getThread(id)?.switch).toMatchObject({
    state: "queued",
    lossy: true,
    recommendation: "delegate_task",
  });
  expect(sourceSession?.closed).toBe(false);
  expect(h.store.getThread(id)?.provider).toBe("codex");
  h.emit(
    id,
    {
      type: "background.started",
      agent: "root",
      task: "build",
      kind: "shell",
      title: "Build",
      stoppable: true,
    },
    { type: "turn.ended", agent: "root", outcome: "completed" },
  );
  await h.engine.flush();
  expect(h.store.getThread(id)?.provider).toBe("codex");
  h.emit(id, { type: "background.ended", task: "build", status: "completed" });
  await h.engine.flush();
  expect(h.store.getThread(id)?.switch?.state).toBe("applied");
  expect(h.store.getThread(id)?.provider).toBe("claude");
  expect(sourceSession?.closed).toBe(true);
});
test("same-provider model changes preserve the native session and private history", async () => {
  const h = setup();
  const id = await h.create();
  const session = h.sessions[0];
  expect(
    h.command({
      type: "thread.switch",
      threadId: id,
      selection: { provider: "codex", model: "model-b", options: { effort: "high" } },
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  follow(h, id);
  await h.engine.flush();
  expect(h.inputs.at(-1)).toMatchObject({
    nativeId: session?.nativeId,
    model: "model-b",
    options: { effort: "high" },
  });
  expect(h.store.getThread(id)?.switch?.lossy).toBe(false);
  const text = Object.values(h.store.snapshotThread(id).items).flatMap((item) =>
    item.type === "message" ? item.parts : [],
  );
  expect(text).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining("source history") }),
    ]),
  );
  expect(session?.closed).toBe(false);
});
test("same-provider model changes use native resume when live configuration is unavailable", async () => {
  const h = setup({ configure: false });
  const id = await h.create();
  const original = h.sessions[0]?.nativeId;
  expect(
    h.command({
      type: "thread.switch",
      threadId: id,
      selection: { provider: "codex", model: "model-b" },
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  follow(h, id);
  await h.engine.flush();
  expect(h.sessions.at(-1)?.context.resume?.nativeSessionId).toBe(original);
  expect(h.inputs.at(-1)).toMatchObject({ nativeId: original, model: "model-b" });
});
test("cross-provider switches mark loss and deliver portable provenance to the new provider", async () => {
  const h = setup();
  const id = await h.create();
  const original = h.sessions[0]?.nativeId;
  expect(
    h.command({
      type: "thread.switch",
      threadId: id,
      selection: { provider: "cursor", model: "cursor-model" },
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  follow(h, id);
  await h.engine.flush();
  expect(h.inputs.at(-1)?.provider).toBe("cursor");
  expect(h.inputs.at(-1)?.nativeId).not.toBe(original);
  expect(h.inputs.at(-1)?.text).toContain('"sourceThreadId":"' + id + '"');
  expect(h.inputs.at(-1)?.text).toContain("source history");
  expect(h.store.getThread(id)?.switch).toMatchObject({
    lossy: true,
    recommendation: "delegate_task",
  });
});
test("provider and model options are remembered independently when returning to a selection", async () => {
  const h = setup();
  const id = await h.create();
  h.command({
    type: "thread.switch",
    threadId: id,
    selection: { provider: "codex", model: "model-a", options: { effort: "low" } },
  });
  await h.engine.flush();
  h.command({
    type: "thread.switch",
    threadId: id,
    selection: { provider: "codex", model: "model-b", options: { effort: "high" } },
  });
  await h.engine.flush();
  h.command({
    type: "thread.switch",
    threadId: id,
    selection: { provider: "claude", model: "claude-model", options: { effort: "medium" } },
  });
  await h.engine.flush();
  h.command({
    type: "thread.switch",
    threadId: id,
    selection: { provider: "codex", model: "model-a" },
  });
  await h.engine.flush();
  follow(h, id);
  await h.engine.flush();
  expect(h.inputs.at(-1)).toMatchObject({
    provider: "codex",
    model: "model-a",
    options: { effort: "low" },
  });
  h.command({ type: "thread.switch", threadId: id, selection: { provider: "claude" } });
  await h.engine.flush();
  follow(h, id);
  await h.engine.flush();
  expect(h.inputs.at(-1)).toMatchObject({
    provider: "claude",
    model: "claude-model",
    options: { effort: "medium" },
  });
});
test("the latest queued switch wins and survives a daemon restart", async () => {
  const h = setup();
  const id = await h.create();
  h.held.add(id);
  follow(h, id);
  await h.engine.flush();
  h.command({
    type: "thread.switch",
    threadId: id,
    selection: { provider: "claude", model: "older" },
  });
  h.command({
    type: "thread.switch",
    threadId: id,
    selection: { provider: "cursor", model: "newest" },
  });
  await h.engine.flush();
  await h.restart();
  await h.engine.flush();
  expect(h.store.getThread(id)?.switch).toMatchObject({
    state: "applied",
    selection: { provider: "cursor", model: "newest" },
  });
  h.held.delete(id);
  follow(h, id);
  await h.engine.flush();
  expect(h.inputs.at(-1)?.provider).toBe("cursor");
  expect(h.inputs.at(-1)?.text).toContain("source history");
});
test("account migration refusal preserves the original account and native session", async () => {
  const h = setup({
    io: {
      applyPatch: async () => {},
      migrate: async () => ({ status: "refused", reason: "Exclusive writer lease unavailable" }),
    },
  });
  const id = await h.create();
  const original = h.sessions[0]?.nativeId;
  h.command({
    type: "thread.switch",
    threadId: id,
    selection: { provider: "codex", instanceId: "account-b" },
  });
  await h.engine.flush();
  expect(h.store.getThread(id)?.switch).toMatchObject({
    state: "failed",
    lossy: false,
    error: "Exclusive writer lease unavailable",
  });
  follow(h, id);
  await h.engine.flush();
  expect(h.sessions.at(-1)?.context.instanceId).toBe("account-a");
  expect(h.inputs.at(-1)?.nativeId).toBe(original);
});

test("a failed provider close retains the old session and refuses a cross-provider switch", async () => {
  const h = setup({ closeFails: true });
  const id = await h.create();
  const original = h.sessions[0]?.nativeId;
  h.command({ type: "thread.switch", threadId: id, selection: { provider: "claude" } });
  await h.engine.flush();
  expect(h.store.getThread(id)?.provider).toBe("codex");
  expect(h.store.getThread(id)?.switch?.state).toBe("failed");
  expect(h.sessions[0]?.closed).toBe(false);
  follow(h, id);
  await h.engine.flush();
  expect(h.inputs.at(-1)?.nativeId).toBe(original);
  expect(h.inputs.at(-1)?.provider).toBe("codex");
});

test("failed configuration and rollback prevent turns on an uncertain native session", async () => {
  const h = setup({ configureFails: true });
  const id = await h.create();
  const sent = h.inputs.length;
  h.command({ type: "thread.switch", threadId: id, selection: { provider: "codex", model: "model-b" } });
  await h.engine.flush();
  expect(h.store.getThread(id)?.switch).toMatchObject({
    state: "failed",
    error: expect.stringContaining("rollback failed"),
  });
  follow(h, id);
  await h.engine.flush();
  expect(h.inputs).toHaveLength(sent);
  expect(h.sessions[0]?.closed).toBe(true);
});
