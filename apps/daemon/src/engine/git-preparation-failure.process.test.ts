import { afterEach, expect, test } from "vitest";
import { GitError } from "@ace/git";
import { fixture, cleanupRecovery, dispatch, text } from "./recovery-test-support.ts";
import { scriptFrames, start, end } from "./test-support.ts";

afterEach(cleanupRecovery);

test.each(["session opening", "checkpoint", "workspace guard"])(
  "a local Git timeout during %s keeps the message and retry delivers it once",
  async (stage) => {
    let blocked = true;
    const check = async () => {
      if (blocked) throw new GitError("git_timeout", "Git exceeded 30000ms");
    };
    const frames = scriptFrames();
    const h = await fixture([{ on: "send", frames: [frames.frame(start, end)] }], frames, {
      ...(stage === "checkpoint" ? { beforeSend: check } : {}),
      ...(stage === "workspace guard" ? { assertWorkspaceAvailable: check } : {}),
    });
    if (stage === "session opening")
      h.registry.register(
        {
          ...h.adapter,
          async openSession(context) {
            await check();
            return h.adapter.openSession(context);
          },
        },
        { installed: true, auth: "logged_in", loginHint: "unused" },
      );
    const id = await h.create();
    expect(h.engine.queue(id)).toMatchObject({
      paused: true,
      reason: "not_sent",
      pendingCount: 1,
      lastFailure: { code: "git_timeout", title: expect.stringContaining("Git took too long") },
    });
    expect(h.adapter.commands.filter((entry) => entry.type === "send")).toEqual([]);
    expect(h.engine.queue(id).lastFailure?.title).not.toMatch(/provider|sign-in/);
    blocked = false;
    dispatch(
      h.store,
      h.engine,
      {
        type: "queue.resume",
        threadId: id,
        expectedRevision: h.engine.queue(id).revision,
      },
      "retry-local-preparation",
    );
    await h.engine.flush();
    expect(
      h.adapter.commands.filter((entry) => entry.type === "send").map((entry) => entry.input),
    ).toEqual([text("first")]);
    expect(h.engine.queue(id)).toMatchObject({ pendingCount: 0, lastFailure: null });
  },
);

test("steering a live turn reaches the same session without waiting for another checkpoint", async () => {
  const frames = scriptFrames();
  const h = await fixture(
    [
      { on: "send", frames: [frames.frame(start)] },
      { on: "send", frames: [] },
    ],
    frames,
    {
      steer: true,
      beforeSend: async (_id, command) => {
        if (command === "correction") throw new GitError("git_timeout", "Git exceeded 30000ms");
      },
    },
  );
  const id = await h.create();
  dispatch(
    h.store,
    h.engine,
    { type: "thread.send", threadId: id, input: text("correction"), delivery: "steer" },
    "correction",
  );
  await h.engine.flush();
  expect(
    h.adapter.commands
      .filter((entry) => entry.type === "send")
      .map((entry) => ({ input: entry.input, delivery: entry.delivery })),
  ).toEqual([
    { input: text("first"), delivery: "queue" },
    { input: text("correction"), delivery: "steer" },
  ]);
  expect(h.contexts).toHaveLength(1);
  expect(h.engine.queue(id)).toMatchObject({ pendingCount: 0, paused: false, lastFailure: null });
  expect(h.store.getThread(id)?.status.state).toBe("working");
});
