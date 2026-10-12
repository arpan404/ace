import { afterEach, expect, test } from "vitest";
import { CommandPayload } from "@ace/protocol";
import {
  fixture,
  cleanupRecovery,
  replaceProvider,
  crashCopy,
  dispatch,
  sends,
  text,
} from "./recovery-test-support.ts";
import { scriptFrames, start, end } from "./test-support.ts";

afterEach(cleanupRecovery);

test.each(["thread.resume", "queue.resume", "thread.limit"] as const)(
  "%s interrupted before session opening finishes is retried without delivery uncertainty",
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
      { on: "send", frames: [frames.frame(start, end)] },
    ]);
    const entered = Promise.withResolvers<void>();
    const retired = Promise.withResolvers<void>();
    const adapter = h.registry.get("codex").adapter;
    let first = true;
    h.registry.register(
      {
        ...adapter,
        async openSession(ctx) {
          if (first) {
            first = false;
            entered.resolve();
            await retired.promise;
            throw new Error("Retired pre-crash opening");
          }
          return adapter.openSession(ctx);
        },
      },
      { installed: true, auth: "logged_in", loginHint: "unused" },
    );
    const payload =
      type === "thread.limit"
        ? {
            type,
            threadId: id,
            expectedRevision: h.engine.queue(id).revision,
            action: "resume_now" as const,
          }
        : { type, threadId: id, expectedRevision: h.engine.queue(id).revision };
    expect(dispatch(h.store, h.engine, CommandPayload.parse(payload)).ok).toBe(true);
    const opening = h.engine.flush();
    try {
      await entered.promise;
      expect(sends(replacement)).toEqual([]);
      const copy = await crashCopy(h);
      expect(sends(replacement).map((command) => command.input)).toEqual([text("continue")]);
      expect(copy.engine.queue(id)).toMatchObject({ paused: false, pendingCount: 0, messages: [] });
      expect(copy.store.getThread(id)?.status.state).toBe("done");
      expect(
        dispatch(
          copy.store,
          copy.engine,
          { type: "queue.resume", threadId: id, expectedRevision: copy.engine.queue(id).revision },
          "resume-after-retry",
        ).ok,
      ).toBe(true);
      await copy.engine.flush();
      expect(sends(replacement)).toHaveLength(1);
    } finally {
      retired.resolve();
      await opening;
    }
  },
);
