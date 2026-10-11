import { CommandId } from "@ace/protocol";
import { afterEach, expect, test } from "vitest";
import {
  fixture,
  cleanupRecovery,
  replaceProvider,
  resume,
  sends,
  dispatch,
  crashCopy,
  text,
} from "./recovery-test-support.ts";
import { scriptFrames, start, end } from "./test-support.ts";

afterEach(cleanupRecovery);

test("possibly consumed continuation refuses another resume until late correlated proof settles it", async () => {
  const frames = scriptFrames();
  const h = await fixture(
    [
      {
        on: "send",
        frames: [
          frames.frame(start, {
            type: "turn.ended",
            agent: "root",
            outcome: "failed",
            error: { kind: "quota", message: "Quota" },
          }),
        ],
      },
    ],
    frames,
    { steer: true },
  );
  const id = await h.create();
  const replacement = replaceProvider(h, frames, [
    { on: "send" },
    { on: "send", frames: [frames.frame(start, end)] },
  ]);
  const original = h.registry.get("codex").adapter;
  h.registry.register(
    {
      ...original,
      async openSession(ctx) {
        const session = await original.openSession(ctx);
        return {
          ...session,
          async send(input, mode, commandId) {
            await session.send(input, mode, commandId);
            if (commandId === "recovery-command")
              throw new Error("Continuation may have been consumed");
          },
        };
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  expect(resume(h, h.engine, id).ok).toBe(true);
  await h.engine.flush();
  expect(
    dispatch(
      h.store,
      h.engine,
      { type: "queue.resume", threadId: id, expectedRevision: h.engine.queue(id).revision },
      "resume-again",
    ).error,
  ).toBe("uncertain_delivery");
  expect(sends(replacement)).toHaveLength(1);
  expect(h.engine.queue(id)).toMatchObject({
    paused: true,
    reason: "uncertain",
    pendingCount: 1,
    messages: [{ id: "recovery-command", input: text("continue"), state: "uncertain" }],
  });
  const copy = await crashCopy(h);
  expect(
    dispatch(
      copy.store,
      copy.engine,
      { type: "thread.resume", threadId: id, expectedRevision: copy.engine.queue(id).revision },
      "resume-after-restart",
    ).error,
  ).toBe("uncertain_delivery");
  expect(sends(replacement)).toHaveLength(1);
  h.contexts.at(-1)?.onFrame(
    frames.frame(
      {
        type: "input.admitted",
        agent: "root",
        nativeInputId: "native-continuation",
        commandId: "recovery-command",
      },
    ),
  );
  await h.engine.flush();
  expect(h.engine.queue(id)).toMatchObject({ paused: true, reason: "uncertain" });
  h.contexts.at(-1)?.onFrame(frames.frame(start));
  await h.engine.flush();
  expect(h.engine.queue(id)).toMatchObject({ pendingCount: 0, messages: [], paused: false });
  h.contexts.at(-1)?.onFrame(frames.frame(end));
  await h.engine.flush();
  expect(h.engine.queue(id)).toMatchObject({ pendingCount: 0, messages: [], paused: false });
  expect(h.store.getThread(id)?.status.state).toBe("done");
  expect(
    Object.values(h.store.snapshotThread(id).runs).some((run) => run.trigger === "limit_resume"),
  ).toBe(true);
  expect(
    h.command({ type: "thread.send", threadId: id, input: text("next"), delivery: "steer" }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(sends(replacement).map((command) => command.input)).toEqual([
    text("continue"),
    text("next"),
  ]);
});

test.each(["queue.remove", "queue.resend"] as const)(
  "%s is an explicit revision-guarded decision for an uncertain continuation",
  async (type) => {
    const frames = scriptFrames();
    const h = await fixture(
      [
        {
          on: "send",
          frames: [
            frames.frame(start, {
              type: "turn.ended",
              agent: "root",
              outcome: "failed",
              error: { kind: "quota", message: "Quota" },
            }),
          ],
        },
      ],
      frames,
    );
    const id = await h.create();
    const replacement = replaceProvider(h, frames, [
      { on: "send" },
      { on: "send", frames: [frames.frame(start, end)] },
    ]);
    const adapter = h.registry.get("codex").adapter;
    h.registry.register(
      {
        ...adapter,
        async openSession(ctx) {
          const session = await adapter.openSession(ctx);
          return {
            ...session,
            async send(input, mode, commandId) {
              await session.send(input, mode, commandId);
              if (commandId === "recovery-command") throw new Error("Lost continuation reply");
            },
          };
        },
      },
      { installed: true, auth: "logged_in", loginHint: "unused" },
    );
    expect(resume(h, h.engine, id).ok).toBe(true);
    await h.engine.flush();
    const revision = h.engine.queue(id).revision;
    expect(
      h.command({
        type,
        threadId: id,
        messageId: CommandId.parse("recovery-command"),
        expectedRevision: revision - 1,
      }).error,
    ).toBe("queue_conflict");
    expect(sends(replacement)).toHaveLength(1);
    expect(
      h.command({
        type,
        threadId: id,
        messageId: CommandId.parse("recovery-command"),
        expectedRevision: revision,
      }).ok,
    ).toBe(true);
    await h.engine.flush();
    expect(sends(replacement)).toHaveLength(type === "queue.resend" ? 2 : 1);
    expect(h.engine.queue(id).messages).toEqual([]);
    expect(h.engine.queue(id).pendingCount).toBe(0);
  },
);

test("retiring a provider awaiting continuation admission preserves its limit trigger and uncertainty", async () => {
  const frames = scriptFrames();
  const h = await fixture(
    [
      {
        on: "send",
        frames: [
          frames.frame(start, {
            type: "turn.ended",
            agent: "root",
            outcome: "failed",
            error: { kind: "quota", message: "Quota" },
          }),
        ],
      },
    ],
    frames,
  );
  const id = await h.create();
  const replacement = replaceProvider(h, frames, [{ on: "send" }]);
  expect(resume(h, h.engine, id).ok).toBe(true);
  await h.engine.flush();
  h.contexts.at(-1)?.onExit({ deliberate: false, message: "Provider disconnected" });
  await h.engine.flush();
  expect(h.engine.queue(id)).toMatchObject({
    reason: "uncertain",
    pendingCount: 1,
    messages: [{ state: "uncertain" }],
  });
  expect(
    dispatch(
      h.store,
      h.engine,
      { type: "thread.resume", threadId: id, expectedRevision: h.engine.queue(id).revision },
      "another-resume",
    ).error,
  ).toBe("uncertain_delivery");
  expect(sends(replacement)).toHaveLength(1);
});
