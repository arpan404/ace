import { afterEach, expect, test } from "vitest";
import { fixture, cleanupRecovery, restart, dispatch, text } from "./recovery-test-support.ts";
import { scriptFrames, start, end } from "./test-support.ts";
afterEach(cleanupRecovery);

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
