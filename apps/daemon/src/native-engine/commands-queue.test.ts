// SPDX-License-Identifier: Apache-2.0
/**
 * E5.4d's queue command branches (the switch on): a resend, a resume's hold, the limit switch,
 * `cancel_resume`, and the sync repair of a hold whose root is no longer limited.
 */
import { describe, expect, test } from "vitest";
import { native, seededQueue, seedIntent, setQueue, storedSend } from "./commands-support.ts";

describe.runIf(native)("E5.4d's queue branches", () => {
  test("a limit hold whose root is no longer limited is retired before the queue reads", async () => {
    const { seam, thread } = await seededQueue();
    try {
      seedIntent(seam, thread, storedSend(thread, "send-a", "once"));
      setQueue(seam, thread, { paused: 1, reason: "limit", limited: 1 });
      const at = seam.clock.now();
      expect(
        seam.engine.handler.handle(
          {
            id: "remove",
            deviceId: "device",
            payload: {
              type: "queue.remove",
              threadId: thread,
              expectedRevision: seam.engine.queue(thread as never).revision,
              messageId: "send-a",
            },
          } as never,
          undefined as never,
        ),
      ).toEqual({ commandId: "remove", ok: true });
      // `recovery.ts:166`-`:172`: the queue's own limit hold is gone but the root's evidence
      // is not, so the hold becomes a cleared-limit marker at this moment.
      expect(
        seam.store.atomic((db) =>
          db
            .prepare("SELECT limited,reason,reset_at FROM engine_queue WHERE thread_id=?")
            .get(thread),
        ),
      ).toEqual({ limited: 0, reason: "manual", reset_at: at });
    } finally {
      await seam.close();
    }
  });

  test("a resend replaces an uncertain send and lifts the uncertainty hold", async () => {
    const { seam, thread } = await seededQueue();
    try {
      seedIntent(seam, thread, storedSend(thread, "send-a", "once"), { uncertain: true });
      setQueue(seam, thread, { paused: 1, reason: "uncertain", limited: 0 });
      const revision = seam.engine.queue(thread as never).revision;
      expect(
        seam.engine.handler.handle(
          {
            id: "resend",
            deviceId: "device",
            payload: {
              type: "queue.resend",
              threadId: thread,
              expectedRevision: revision,
              messageId: "send-a",
            },
          } as never,
          undefined as never,
        ),
      ).toEqual({ commandId: "resend", ok: true });
      const queue = seam.engine.queue(thread as never);
      expect(queue.messages.map((message) => message.id)).toEqual(["resend"]);
      expect(queue.messages[0]?.input).toEqual([{ type: "text", text: "once" }]);
      // The release and the empty `reconcileUncertainty` patch are each a revision bump.
      expect(queue).toMatchObject({ paused: false, reason: null, revision: revision + 2 });
    } finally {
      await seam.close();
    }
  });

  test("a resume adds its intent and holds the queue under the current reason", async () => {
    const { seam, thread } = await seededQueue();
    try {
      const revision = seam.engine.queue(thread as never).revision;
      expect(
        seam.engine.handler.handle(
          {
            id: "resume",
            deviceId: "device",
            payload: { type: "thread.resume", threadId: thread, expectedRevision: revision },
          } as never,
          undefined as never,
        ),
      ).toEqual({ commandId: "resume", ok: true });
      expect(seam.engine.queue(thread as never)).toMatchObject({
        paused: true,
        reason: "manual",
        revision: revision + 1,
      });
      expect(
        seam.store.atomic((db) =>
          db.prepare("SELECT kind FROM intents WHERE command_id='resume'").get(),
        ),
      ).toEqual({ kind: "thread.resume" });
    } finally {
      await seam.close();
    }
  });

  test("a limit switch without a selection is refused before it writes", async () => {
    const { seam, thread } = await seededQueue();
    try {
      const revision = seam.engine.queue(thread as never).revision;
      expect(
        seam.engine.handler.handle(
          {
            id: "switch",
            deviceId: "device",
            payload: {
              type: "thread.limit",
              threadId: thread,
              expectedRevision: revision,
              action: "switch",
            },
          } as never,
          undefined as never,
        ),
      ).toEqual({ commandId: "switch", ok: false, error: "switch_selection_required" });
      expect(seam.engine.queue(thread as never).revision).toBe(revision);
    } finally {
      await seam.close();
    }
  });

  test("cancel_resume turns the scheduled resume into a clear and refuses a second one", async () => {
    const reset = Date.now() + 60_000;
    const { seam, thread } = await seededQueue();
    try {
      setQueue(seam, thread, {
        paused: 1,
        reason: "limit",
        limited: 1,
        resume_at: reset,
        timer_action: "resume",
      });
      expect(seam.engine.queue(thread as never)).toMatchObject({
        paused: true,
        reason: "limit",
        resumeAt: reset,
      });
      const timerAction = (): string | null =>
        (
          seam.store.atomic((db) =>
            db.prepare("SELECT timer_action FROM engine_queue WHERE thread_id=?").get(thread),
          ) as { timer_action: string | null }
        ).timer_action;
      expect(timerAction()).toBe("resume");
      const revision = seam.engine.queue(thread as never).revision;
      const cancel = (id: string) =>
        seam.engine.handler.handle(
          {
            id,
            deviceId: "device",
            payload: {
              type: "thread.limit",
              threadId: thread,
              expectedRevision: seam.engine.queue(thread as never).revision,
              action: "cancel_resume",
            },
          } as never,
          undefined as never,
        );
      expect(cancel("cancel")).toEqual({ commandId: "cancel", ok: true });
      // `shown` hides `resumeAt` for a `clear` deadline, so the stored row is the check.
      expect(seam.engine.queue(thread as never)).toMatchObject({
        paused: true,
        reason: "limit",
        resumeAt: null,
        revision: revision + 1,
      });
      expect(timerAction()).toBe("clear");
      expect(
        seam.store.atomic((db) =>
          db.prepare("SELECT resume_at FROM engine_queue WHERE thread_id=?").get(thread),
        ),
      ).toEqual({ resume_at: reset });
      expect(cancel("cancel-again")).toEqual({
        commandId: "cancel-again",
        ok: false,
        error: "no_scheduled_resume",
      });
    } finally {
      await seam.close();
    }
  });
});
