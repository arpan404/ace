// SPDX-License-Identifier: Apache-2.0
/**
 * E5.4a's in-process seam: the queue read with the switch on. The case is the intended
 * difference from TypeScript recorded in `docs/engine/behaviour.md`: a thread with live intents
 * and no `engine_queue` row must still read its pending work, not an empty queue.
 *
 * (a): `queue-context.process` `:15` reads the same queue once delivery can seed one natively.
 */
import { describe, expect, test } from "vitest";
import { createThreadState } from "@ace/core";
import { AgentId, NativeSessionId, ThreadId } from "@ace/protocol";
import { engineBackend } from "@ace/provider-kit/native-switches";
import { createDevThread } from "../commands.ts";
import { engineSeam } from "./testing.ts";

const native = engineBackend() === "native";

describe.runIf(native)("the queue's pending read", () => {
  test("a thread with intents and no engine_queue row still reads its queued messages", async () => {
    let threadId = "";
    const seam = await engineSeam({
      afterOpen: (store) => {
        const workspace = store.createWorkspace(process.cwd(), "E5.4a");
        const thread = createDevThread(store, workspace).id;
        threadId = thread;
        // Creation writes no `thread_state`, so the opener's queue insert has nothing to add
        // for this thread: the rows below are the only work, with no queue metadata at all.
        const command = (id: string, text: string) =>
          JSON.stringify({
            id,
            deviceId: "device",
            payload: {
              type: "thread.send",
              threadId: thread,
              input: [{ type: "text", text }],
            },
          });
        store.atomic((db) => {
          const insert = db.prepare(
            "INSERT INTO intents (command_id,thread_id,kind,payload,status,delivery,position) VALUES (?,?,'thread.send',?,'pending','queue',?)",
          );
          for (const [position, [id, text]] of (
            [
              ["queued-a", "first"],
              ["queued-b", "second"],
            ] as const
          ).entries())
            insert.run(id, thread, command(id, text), position + 1);
        });
      },
    });
    try {
      const snapshot = seam.engine.queue(threadId as never);
      expect(snapshot).toMatchObject({ pendingCount: 2, revision: 0, paused: false, reason: null });
      expect(snapshot.messages.map((message) => message.id)).toEqual(["queued-a", "queued-b"]);
      const page = seam.engine.queuePage({ threadId: threadId as never });
      expect(page.messages).toHaveLength(2);
      expect(page.total).toBe(2);
    } finally {
      await seam.close();
    }
  });
});

describe.runIf(native)("turn-end queue events", () => {
  test("retiring inputs persists the snooze wake and queue update before the run ends", async () => {
    const seam = await engineSeam();
    try {
      await seam.engine.ready();
      seam.probe.passThroughCollaborators();
      const { store } = seam;
      const workspace = store.createWorkspace(seam.home, "E5.4a");
      const { id } = createDevThread(store, workspace);
      const state = createThreadState({
        threadId: id,
        rootAgent: {
          agent: AgentId.parse("root"),
          fidelity: "full",
          native: { provider: "claude", nativeId: NativeSessionId.parse("native-root") },
          cwd: seam.home,
        },
        config: { provider: "claude", silenceMs: 30_000 },
      });
      store.atomic((db) => {
        db.prepare("INSERT INTO thread_state VALUES (?, ?, ?)").run(
          id,
          JSON.stringify({ ...state, engineSnapshot: 9 }),
          store.headSeq(),
        );
        db.prepare(
          "INSERT INTO engine_queue (thread_id,paused,reason) VALUES (?,1,'not_sent')",
        ).run(id);
        db.prepare(
          "INSERT INTO intents (command_id,thread_id,kind,payload,status,uncertain,submitted_generation) VALUES ('send',?,'thread.send','{}','failed',1,2)",
        ).run(id);
      });
      seam.probe.apply(
        id,
        [{ type: "turn.started", agent: "root", trigger: "user", nativeTurnId: "turn-1" }],
        1_000,
      );
      store.appendEvents(
        id,
        [{ type: "thread.client.updated", changes: { snoozedUntil: 10_000 } }],
        1_100,
      );
      const before = store.headSeq();
      seam.probe.apply(
        id,
        [{ type: "turn.ended", agent: "root", nativeTurnId: "turn-1", outcome: "completed" }],
        2_000,
        2,
      );
      const stored = store.atomic((db) =>
        db
          .prepare(
            `SELECT type FROM events WHERE thread_id=? AND seq>? AND (
              type IN ('queue.updated','run.ended') OR
              (type='thread.client.updated' AND json_extract(payload,'$.changes.snoozeWoke.on')='needs_you')
            ) ORDER BY seq`,
          )
          .all(id, before)
          .map((row) => row.type),
      );
      expect(stored).toEqual(["thread.client.updated", "queue.updated", "run.ended"]);
    } finally {
      await seam.close();
    }
  });
});

async function seededQueue() {
  let thread = "";
  const seam = await engineSeam({
    afterOpen: (store) => {
      const workspace = store.createWorkspace(process.cwd(), "E5.4d");
      const created = createDevThread(store, workspace);
      thread = created.id;
      const state = createThreadState({
        threadId: ThreadId.parse(thread),
        rootAgent: {
          agent: AgentId.parse("root"),
          fidelity: "full",
          native: { provider: "codex", nativeId: NativeSessionId.parse("native-root") },
          cwd: process.cwd(),
        },
        config: { provider: "codex", silenceMs: 30_000 },
      });
      store.atomic((db) => {
        db.prepare("INSERT INTO thread_state VALUES (?, ?, ?)").run(
          thread,
          JSON.stringify({ ...state, engineSnapshot: 9 }),
          store.headSeq(),
        );
        db.prepare("INSERT INTO engine_queue (thread_id) VALUES (?)").run(thread);
      });
    },
  });
  await seam.engine.ready().catch(() => {});
  seam.probe.passThroughCollaborators();
  return { seam, thread };
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
});
