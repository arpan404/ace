import { afterEach, expect, test } from "vitest";
import { fixture, cleanupRecovery, restart, dispatch, text } from "./recovery-test-support.ts";
import { scriptFrames, start, end } from "./test-support.ts";
import { SessionOpenError } from "@ace/provider-kit/open-error";
afterEach(cleanupRecovery);

test.each(["provider", "context", "model"])(
  "a temporary %s opening failure keeps native history retryable and delivers the retained input once",
  async (boundary) => {
    const frames = scriptFrames();
    const h = await fixture([{ on: "send", frames: [frames.frame(start, end)] }], frames);
    const id = await h.create();
    let failing = true;
    const failure = () =>
      boundary === "model"
        ? new SessionOpenError("Model unavailable", {
            code: "model_unavailable",
            detail: "selected model unavailable api_key=private-secret",
          })
        : new Error("Temporary initialization handshake failure api_key=private-secret");
    const resumed: string[] = [];
    h.registry.register(
      {
        ...h.adapter,
        async openSession(ctx) {
          if (failing && boundary !== "context") throw failure();
          if (ctx.resume) resumed.push(ctx.resume.nativeSessionId);
          return h.adapter.openSession(ctx);
        },
      },
      { installed: true, auth: "logged_in", loginHint: "" },
    );
    const engine = await restart(h, {
      sessionContext: async () => {
        if (failing && boundary === "context") throw failure();
        return {};
      },
    });
    dispatch(
      h.store,
      engine,
      { type: "thread.send", threadId: id, input: text("retained follow-up") },
      "temporary-failure",
    );
    await engine.flush();
    const queue = engine.queue(id);
    expect(queue).toMatchObject({
      paused: true,
      reason: boundary === "model" ? "model_unavailable" : "not_sent",
      pendingCount: 1,
      messages: [{ input: text("retained follow-up") }],
    });
    expect(queue.lastFailure?.code).toBe(
      boundary === "model" ? "model_unavailable" : "delivery_failed",
    );
    expect(queue.lastFailure?.title).not.toMatch(
      /Start a new thread|private-secret|api_key|native-/,
    );
    if (boundary !== "model") expect(queue.lastFailure?.title).toContain("try again");
    failing = false;
    dispatch(
      h.store,
      engine,
      { type: "queue.resume", threadId: id, expectedRevision: queue.revision },
      "retry-retained",
    );
    await engine.flush();
    expect(resumed).toEqual(["native-1"]);
    expect(engine.queue(id)).toMatchObject({ pendingCount: 0, lastFailure: null });
    expect(h.store.getThread(id)?.status.state).toBe("done");
    expect(
      h.adapter.commands
        .filter((command) => command.type === "send")
        .map((command) => command.input),
    ).toEqual([text("first"), text("retained follow-up")]);
  },
);

test("a missing native conversation keeps the message and explains the way out after reload", async () => {
  const frames = scriptFrames();
  const h = await fixture([{ on: "send", frames: [frames.frame(start, end)] }], frames);
  const id = await h.create();
  h.registry.register(
    {
      ...h.adapter,
      async openSession(ctx) {
        if (ctx.resume)
          throw new Error(
            'No conversation found for secret-native-id {"request_id":"req_private"}',
          );
        return h.adapter.openSession(ctx);
      },
    },
    { installed: true, auth: "logged_in", loginHint: "" },
  );
  const engine = await restart(h);
  dispatch(
    h.store,
    engine,
    { type: "thread.send", threadId: id, input: text("keep my question") },
    "unsent",
  );
  await engine.flush();
  expect(engine.queue(id)).toMatchObject({
    reason: "not_sent",
    lastFailure: { code: "resume_unavailable" },
    messages: [{ input: text("keep my question") }],
  });
  await engine.close();
  const reloaded = await restart({ ...h, engine });
  const failure = reloaded.queue(id).lastFailure;
  expect(failure?.title).toContain("Start a new thread");
  expect(failure?.title).not.toMatch(/secret-native-id|req_private|\{|JSON/);
});

test("an opened conversation with no native initialization is reopened fresh after a restart", async () => {
  const frames = scriptFrames();
  const h = await fixture([], frames, {
    beforeSend: async () => {
      throw new Error("input preparation failed");
    },
  });
  const adapter = h.adapter;
  const opens: string[] = [];
  h.registry.register(
    {
      ...adapter,
      async openSession(ctx) {
        opens.push(ctx.resume ? "resume" : "fresh");
        const session = await adapter.openSession(ctx);
        return { ...session, sessionConfirmed: false };
      },
    },
    { installed: true, auth: "logged_in", loginHint: "" },
  );
  const id = await h.create();
  const engine = await restart(h);
  dispatch(
    h.store,
    engine,
    { type: "queue.resume", threadId: id, expectedRevision: engine.queue(id).revision },
    "retry",
  );
  await engine.flush();
  expect(opens).toEqual(["fresh", "fresh"]);
  expect(engine.queue(id).lastFailure).toBeNull();
});
