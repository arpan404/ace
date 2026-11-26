// SPDX-License-Identifier: Apache-2.0
/**
 * E5.4d's refusals and rollback (the switch on). The order the receipt checks is contract
 * (`docs/engine/e5-4-brief.md`, "The receipt, rule by rule"), so each case seeds the condition
 * and asserts the whole refusal.
 */
import { describe, expect, test } from "vitest";
import { native, seededQueue } from "./commands-support.ts";

/** A command as the person's device sends it. */
function command(id: string, payload: Record<string, unknown>): never {
  return { id, deviceId: "device", payload } as never;
}

describe.runIf(native)("E5.4d's refusals and rollback", () => {
  test("a refused receipt before the atomic step writes nothing and releases no wake", async () => {
    const { seam, thread } = await seededQueue();
    try {
      const revision = seam.engine.queue(thread as never).revision;
      const seq = seam.store.headSeq();
      const woken = seam.probe.woken().length;
      expect(
        seam.engine.handler.handle(
          {
            id: "rename",
            deviceId: "device",
            payload: { type: "thread.rename", threadId: thread, title: "Mine" },
          } as never,
          undefined as never,
        ),
      ).toEqual({ commandId: "rename", ok: false, error: "not_implemented" });
      expect(seam.engine.queue(thread as never).revision).toBe(revision);
      expect(seam.store.headSeq()).toBe(seq);
      expect(seam.probe.woken()).toHaveLength(woken);
    } finally {
      await seam.close();
    }
  });

  test("a queue command whose policy throws after accepting rolls back: no revision bump, no wake", async () => {
    const { seam, thread } = await seededQueue();
    try {
      const revision = seam.engine.queue(thread as never).revision;
      const updated = seam.store.atomic(
        (db) =>
          (
            db
              .prepare(
                "SELECT COUNT(*) AS n FROM events WHERE thread_id=? AND type='queue.updated'",
              )
              .get(thread) as { n: number }
          ).n,
      );
      seam.engine.bindCommandPolicy(((_command: unknown, accept: () => unknown) => {
        accept();
        throw new Error("policy failed");
      }) as never);
      expect(() =>
        seam.engine.handler.handle(
          {
            id: "pause",
            deviceId: "device",
            payload: { type: "queue.pause", threadId: thread, expectedRevision: revision },
          } as never,
          undefined as never,
        ),
      ).toThrow("policy failed");
      expect(seam.engine.queue(thread as never).revision).toBe(revision);
      expect(
        seam.store.atomic(
          (db) =>
            (
              db
                .prepare(
                  "SELECT COUNT(*) AS n FROM events WHERE thread_id=? AND type='queue.updated'",
                )
                .get(thread) as { n: number }
            ).n,
        ),
      ).toBe(updated);
    } finally {
      await seam.close();
    }
  });

  test("a limit resume that rolls back neither wakes nor touches the deadline timer", async () => {
    const reset = Date.now() + 60_000;
    const { seam, thread } = await seededQueue({ recovery: { resetAt: () => reset } });
    try {
      const revision = seam.engine.queue(thread as never).revision;
      const woken = seam.probe.woken().length;
      const armed = seam.ports.calls.filter((call) => call.port === "clock.setTimer").length;
      const timers = seam.probe.timerCount();
      seam.engine.bindCommandPolicy(((_command: unknown, accept: () => unknown) => {
        accept();
        throw new Error("policy failed");
      }) as never);
      expect(() =>
        seam.engine.handler.handle(
          {
            id: "limit",
            deviceId: "device",
            payload: {
              type: "thread.limit",
              threadId: thread,
              expectedRevision: revision,
              action: "resume_at_reset",
            },
          } as never,
          undefined as never,
        ),
      ).toThrow("policy failed");
      expect(seam.engine.queue(thread as never).revision).toBe(revision);
      expect(seam.probe.woken()).toHaveLength(woken);
      // `schedule` is after-commit (`docs/engine/e5-4-brief.md`, "Receipt effects are
      // commit-scoped"), so a rolled-back receipt cancels nothing and arms nothing.
      expect(seam.probe.timerCount()).toBe(timers);
      expect(seam.ports.calls.filter((call) => call.port === "clock.setTimer")).toHaveLength(armed);
    } finally {
      await seam.close();
    }
  });

  test("the fence refuses only turn commands, and the production {code, detail} becomes a refusal", async () => {
    const { seam, thread } = await seededQueue();
    try {
      const revision = seam.engine.queue(thread as never).revision;
      const asked: string[] = [];
      // `ThreadOwnership.refusal` answers `{code, detail}` (`services/engine.ts:575`).
      seam.engine.bindOwnershipFence(((id: string) => {
        asked.push(id);
        return id === thread
          ? { code: "thread_moved", detail: "Thread moved to Laptop" }
          : undefined;
      }) as never);
      expect(
        seam.engine.handler.handle(
          command("send", {
            type: "thread.send",
            threadId: thread,
            input: [{ type: "text", text: "hi" }],
          }),
          undefined as never,
        ),
      ).toEqual({
        commandId: "send",
        ok: false,
        error: "thread_moved",
        code: "thread_moved",
        detail: "Thread moved to Laptop",
      });
      // A turn command is the only thing the fence sees; the rest pass to the receipt.
      expect(asked).toEqual([thread]);
      expect(() =>
        seam.engine.handler.handle(
          command("interrupt", { type: "thread.interrupt", threadId: thread }),
          undefined as never,
        ),
      ).toThrow("E5.4e");
      expect(() =>
        seam.engine.handler.handle(
          command("archive", { type: "thread.archive", threadId: thread }),
          undefined as never,
        ),
      ).toThrow("E5.4e");
      expect(
        seam.engine.handler.handle(
          command("pause", {
            type: "queue.pause",
            threadId: thread,
            expectedRevision: revision,
          }),
          undefined as never,
        ),
      ).toEqual({ commandId: "pause", ok: true });
      expect(asked).toEqual([thread]);
    } finally {
      await seam.close();
    }
  });

  test("the account's reset holds the queue and arms the timer when none is stored", async () => {
    const reset = Date.now() + 60_000;
    const { seam, thread } = await seededQueue({ recovery: { resetAt: () => reset } });
    try {
      expect(
        seam.engine.handler.handle(
          {
            id: "limit",
            deviceId: "device",
            payload: {
              type: "thread.limit",
              threadId: thread,
              expectedRevision: seam.engine.queue(thread as never).revision,
              action: "resume_at_reset",
            },
          } as never,
          undefined as never,
        ),
      ).toMatchObject({ ok: true });
      expect(seam.engine.queue(thread as never)).toMatchObject({
        paused: true,
        reason: "limit",
        resumeAt: reset,
      });
    } finally {
      await seam.close();
    }
  });

  test("a stale stored reset is refused when the account reports none", async () => {
    const { seam, thread } = await seededQueue({ recovery: { resetAt: () => null } }, 1_000);
    try {
      expect(
        seam.engine.handler.handle(
          {
            id: "limit",
            deviceId: "device",
            payload: {
              type: "thread.limit",
              threadId: thread,
              expectedRevision: seam.engine.queue(thread as never).revision,
              action: "resume_at_reset",
            },
          } as never,
          undefined as never,
        ),
      ).toEqual({ commandId: "limit", ok: false, error: "reset_time_unknown" });
      expect(seam.engine.queue(thread as never).paused).toBe(false);
    } finally {
      await seam.close();
    }
  });

  test("a reset port that answers undefined falls back to the stored reset", async () => {
    const reset = Date.now() + 60_000;
    // Production answers undefined when the thread has no account or quota
    // (`services/recovery.ts:59`-`:63`), so the stored reading still holds.
    const { seam, thread } = await seededQueue({ recovery: { resetAt: () => undefined } }, reset);
    try {
      expect(
        seam.engine.handler.handle(
          {
            id: "limit",
            deviceId: "device",
            payload: {
              type: "thread.limit",
              threadId: thread,
              expectedRevision: seam.engine.queue(thread as never).revision,
              action: "resume_at_reset",
            },
          } as never,
          undefined as never,
        ),
      ).toEqual({ commandId: "limit", ok: true });
      expect(seam.engine.queue(thread as never)).toMatchObject({
        paused: true,
        reason: "limit",
        resumeAt: reset,
      });
    } finally {
      await seam.close();
    }
  });

  test("a throwing reset port rolls the limit command back", async () => {
    const { seam, thread } = await seededQueue({
      recovery: {
        resetAt: () => {
          throw new Error("reset port failed");
        },
      },
    });
    try {
      const revision = seam.engine.queue(thread as never).revision;
      const seq = seam.store.headSeq();
      expect(() =>
        seam.engine.handler.handle(
          {
            id: "limit",
            deviceId: "device",
            payload: {
              type: "thread.limit",
              threadId: thread,
              expectedRevision: revision,
              action: "resume_at_reset",
            },
          } as never,
          undefined as never,
        ),
      ).toThrow("reset port failed");
      expect(seam.engine.queue(thread as never).revision).toBe(revision);
      expect(seam.store.headSeq()).toBe(seq);
    } finally {
      await seam.close();
    }
  });

  test("migrate_now needs moveTarget to have been given", async () => {
    const absent = await seededQueue();
    try {
      expect(
        absent.seam.engine.handler.handle(
          {
            id: "migrate",
            deviceId: "device",
            payload: {
              type: "thread.limit",
              threadId: absent.thread,
              expectedRevision: absent.seam.engine.queue(absent.thread as never).revision,
              action: "migrate_now",
            },
          } as never,
          undefined as never,
        ),
      ).toEqual({ commandId: "migrate", ok: false, error: "migration_unavailable" });
    } finally {
      await absent.seam.close();
    }
    const present = await seededQueue({ recovery: { moveTarget: () => "acct-2" } });
    try {
      expect(
        present.seam.engine.handler.handle(
          {
            id: "migrate",
            deviceId: "device",
            payload: {
              type: "thread.limit",
              threadId: present.thread,
              expectedRevision: present.seam.engine.queue(present.thread as never).revision,
              action: "migrate_now",
            },
          } as never,
          undefined as never,
        ),
      ).toMatchObject({ ok: true });
    } finally {
      await present.seam.close();
    }
  });
});
