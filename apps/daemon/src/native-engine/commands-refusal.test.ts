// SPDX-License-Identifier: Apache-2.0
/**
 * E5.4d's refusals, the receipt's ports and its rollback (the switch on). The order the receipt
 * checks is contract (`docs/engine/e5-4-brief.md`, "The receipt, rule by rule"), so each case
 * seeds the condition and asserts the whole refusal.
 */
import { describe, expect, test } from "vitest";
import { createThreadState } from "@ace/core";
import { AgentId, NativeSessionId, ThreadId } from "@ace/protocol";
import { engineBackend } from "@ace/provider-kit/native-switches";
import { createDevThread } from "../commands.ts";
import { AdapterRegistry } from "../engine/registry.ts";
import type { EngineOptions } from "../engine/engine-options.ts";
import { engineSeam, type EngineSeam } from "./testing.ts";

const native = engineBackend() === "native";

/** A codex adapter entry, so the provider admission policy has a backend to ask about. */
function codexAdapter(backend: string) {
  return {
    provider: "codex",
    backend,
    capabilities: () => ({ steer: false }),
    createTranslator: () => ({}) as never,
    openSession: async () => ({}) as never,
  } as never;
}

function codexRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(codexAdapter("sdk"), { installed: true, auth: "ok" } as never);
  return registry;
}

/** A thread the receipt's State finds, with a queue row and a session row. */
async function seededQueue(
  options: Partial<EngineOptions> = {},
  storedResetAt?: number,
): Promise<{ seam: EngineSeam; thread: string }> {
  let thread = "";
  const seam = await engineSeam({
    options,
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
        db.prepare("INSERT INTO engine_queue (thread_id, reset_at, limited) VALUES (?, ?, 1)").run(
          thread,
          storedResetAt ?? null,
        );
        db.prepare("INSERT INTO engine_sessions (thread_id, cwd, backend) VALUES (?, ?, NULL)").run(
          thread,
          process.cwd(),
        );
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

  test("a fenced thread's queue command is refused by the ownership fence", async () => {
    const { seam, thread } = await seededQueue();
    try {
      const revision = seam.engine.queue(thread as never).revision;
      seam.engine.bindOwnershipFence(((id: string) =>
        id === thread
          ? { commandId: "pause", ok: false, error: "thread_moved" }
          : undefined) as never);
      expect(
        seam.engine.handler.handle(
          {
            id: "pause",
            deviceId: "device",
            payload: { type: "queue.pause", threadId: thread, expectedRevision: revision },
          } as never,
          undefined as never,
        ),
      ).toEqual({ commandId: "pause", ok: false, error: "thread_moved" });
      expect(seam.engine.queue(thread as never).revision).toBe(revision);
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

describe.runIf(native)("the receipt's provider ports", () => {
  test("selectInstance answers the default account with the registry's backend", async () => {
    const seen: { provider: string; instance: string | undefined }[] = [];
    const { seam, thread } = await seededQueue({
      registry: codexRegistry(),
      selectInstance: (_provider, backend) => `acct-${backend as string}`,
      providerEnabled: (provider, instance) => {
        seen.push({ provider, instance });
        return instance !== "acct-sdk";
      },
    });
    try {
      expect(
        seam.engine.handler.handle(
          {
            id: "resume",
            deviceId: "device",
            payload: { type: "thread.resume", threadId: thread },
          } as never,
          undefined as never,
        ),
      ).toEqual({ commandId: "resume", ok: false, error: "provider_disabled" });
      expect(seen[0]).toEqual({ provider: "codex", instance: "acct-sdk" });
    } finally {
      await seam.close();
    }
  });

  test("a throwing providerEnabled port rolls the receipt back and the revision is unchanged", async () => {
    const { seam, thread } = await seededQueue({
      registry: codexRegistry(),
      selectInstance: () => "acct",
      providerEnabled: () => {
        throw new Error("port failed");
      },
    });
    try {
      const revision = seam.engine.queue(thread as never).revision;
      const seq = seam.store.headSeq();
      expect(() =>
        seam.engine.handler.handle(
          {
            id: "resume",
            deviceId: "device",
            payload: { type: "thread.resume", threadId: thread },
          } as never,
          undefined as never,
        ),
      ).toThrow("port failed");
      expect(seam.engine.queue(thread as never).revision).toBe(revision);
      expect(seam.store.headSeq()).toBe(seq);
    } finally {
      await seam.close();
    }
  });
});

describe.runIf(native)("a closed maintenance gate", () => {
  test("a closed gate leaves no deadline armed", async () => {
    let timers = 0;
    const seam = await engineSeam({
      options: {
        recovery: { admits: () => false },
        clock: {
          now: () => Date.now(),
          setTimer: () => {
            timers += 1;
            return () => {};
          },
        },
      } as never,
    });
    try {
      // A queue command that would arm a deadline must not, while maintenance holds work.
      seam.engine.admissionReopened();
      expect(timers).toBe(0);
    } finally {
      await seam.close();
    }
  });
});
