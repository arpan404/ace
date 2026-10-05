import { afterEach, expect, test } from "vitest";
import { transitionHarness } from "./transition-test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
function setup(options: Parameters<typeof transitionHarness>[0]) {
  const h = transitionHarness(options);
  cleanups.push(h.close);
  return h;
}

test("forking a limited thread leaves its held server queue and quota on the source", async () => {
  const options = { native: true, limited: true, forkPoints: ["end" as const] };
  const h = setup(options);
  const source = await h.create();
  for (const text of ["one", "two"])
    expect(
      h.command({
        type: "thread.send",
        threadId: source,
        input: [{ type: "text", text }],
      }).ok,
    ).toBe(true);
  await h.engine.flush();
  const before = h.engine.queue(source);
  options.limited = false;
  const fork = await h.fork(source);
  expect(h.engine.queue(source)).toMatchObject({
    paused: true,
    reason: "limit",
    messages: before.messages,
  });
  expect(h.store.getThread(source)?.status.state).toBe("limited");
  expect(h.engine.queue(fork)).toMatchObject({ paused: false, messages: [] });
  expect(h.store.getThread(fork)?.status.state).toBe("done");
  expect(h.inputs.some((input) => input.text === "one" || input.text === "two")).toBe(false);
});

test("an unclaimed whole-session fork can resume after restart without releasing its source queue", async () => {
  const h = setup({ native: true, forkPoints: ["end"] });
  const source = await h.create();
  expect(
    h.command({
      type: "queue.pause",
      threadId: source,
      expectedRevision: h.engine.queue(source).revision,
    }).ok,
  ).toBe(true);
  expect(
    h.command({
      type: "thread.send",
      threadId: source,
      input: [{ type: "text", text: "held source input" }],
    }).ok,
  ).toBe(true);
  const fork = h.command({
    type: "thread.fork",
    threadId: source,
    point: { type: "turn", runId: h.finishedRun(source).id },
    input: "fork after restart",
    budgetBytes: 4096,
  });
  expect(fork.ok).toBe(true);
  if (!fork.forkThreadId) throw new Error("Missing fork receipt");
  await h.restart();
  await h.engine.flush();
  expect(h.inputs).toHaveLength(1);
  expect(h.engine.queue(fork.forkThreadId).paused).toBe(true);
  expect(
    h.command({
      type: "thread.resume",
      threadId: fork.forkThreadId,
      expectedRevision: h.engine.queue(fork.forkThreadId).revision,
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(h.inputs.map((input) => input.text)).toEqual(["source history", "fork after restart"]);
  expect(h.store.getThread(fork.forkThreadId)?.status.state).toBe("done");
  expect(h.engine.queue(source)).toMatchObject({
    paused: true,
    messages: [expect.objectContaining({ input: [{ type: "text", text: "held source input" }] })],
  });
});

for (const destination of ["provider", "account"] as const) {
  test(`switching a limited ${destination} preserves held order and resumes recovery on the destination`, async () => {
    const options = {
      native: true,
      limited: true,
      recovery: { resetAt: () => 5000 },
      preferences: { limitPolicy: "resume_at_reset" as const },
      io: {
        migrate: async (request: { nativeSessionId: string }) => ({
          status: "migrated" as const,
          nativeSessionId: request.nativeSessionId,
          action: "resume" as const,
          copiedFiles: 1,
          env: {},
        }),
        applyPatch: async () => {},
      },
    };
    const h = setup(options);
    const id = await h.create();
    const root = h.store.getThread(id)?.rootAgentId;
    if (!root) throw new Error("Missing root agent");
    const meter = () => h.store.snapshotThread(id).contextMeters?.[root];
    h.emit(id, {
      type: "context.sample",
      agent: "root",
      usedTokens: 800,
      windowTokens: 10000,
      model: "model-a",
    });
    await h.engine.flush();
    expect(meter()?.usedTokens).toBe(800);
    for (const text of ["one", "two"])
      expect(
        h.command({
          type: "thread.send",
          threadId: id,
          input: [{ type: "text", text }],
        }).ok,
      ).toBe(true);
    await h.engine.flush();
    const before = h.engine.queue(id);
    expect(before.resumeAt).toBe(5000);
    options.limited = false;
    const provider = destination === "provider" ? "claude" : "codex";
    expect(
      h.command({
        type: "thread.switch",
        threadId: id,
        selection: {
          provider,
          ...(destination === "account" ? { instanceId: "account-b" } : {}),
        },
      }).ok,
    ).toBe(true);
    await h.engine.flush();
    expect(h.store.getThread(id)?.switch?.state).toBe("applied");
    expect(meter()?.usedTokens).toBeNull();
    expect(h.engine.queue(id)).toMatchObject({ paused: true, messages: before.messages });
    expect(h.store.getThread(id)?.status.state).toBe("waiting");
    expect(h.engine.queue(id).resumeAt).toBeNull();
    h.clock.advance(5000);
    await h.engine.flush();
    expect(h.inputs).toHaveLength(1);
    expect(
      h.command({
        type: "thread.resume",
        threadId: id,
        expectedRevision: h.engine.queue(id).revision,
      }).ok,
    ).toBe(true);
    await h.engine.flush();
    expect(h.inputs.slice(1).map((input) => input.provider)).toEqual([
      provider,
      provider,
      provider,
    ]);
    expect(h.inputs.slice(2).map((input) => input.text)).toEqual(["one", "two"]);
    expect(h.inputs[1]?.text.split("\n").at(-1)).toBe("continue");
    expect(h.sessions.at(-1)?.context.instanceId).toBe(
      destination === "account" ? "account-b" : undefined,
    );
    expect(h.engine.queue(id).messages).toHaveLength(0);
    expect(h.store.getThread(id)?.status.state).toBe("done");
  });
}
