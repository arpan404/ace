// SPDX-License-Identifier: Apache-2.0
/**
 * E5.4d's refusals, the receipt's ports and its rollback (the switch on). The order the receipt
 * checks is contract (`docs/engine/e5-4-brief.md`, "The receipt, rule by rule"), so each case
 * seeds the condition and asserts the whole refusal.
 */
import { describe, expect, test } from "vitest";
import { createThreadState } from "@ace/core";
import { AgentId, Command, NativeSessionId, ThreadId } from "@ace/protocol";
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

/** A stored command, as the TypeScript store writes it. */
function storedSend(thread: string, id: string, text = "hello") {
  return Command.parse({
    id,
    deviceId: "device",
    payload: {
      type: "thread.send",
      threadId: thread,
      input: [{ type: "text", text }],
    },
  });
}

function seedIntent(
  seam: EngineSeam,
  thread: string,
  command: ReturnType<typeof storedSend>,
  options: { uncertain?: boolean; status?: string } = {},
): void {
  seam.store.atomic((db) =>
    db
      .prepare(
        "INSERT INTO intents (command_id,thread_id,kind,payload,status,delivery,position,uncertain) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(
        command.id,
        thread,
        command.payload.type,
        JSON.stringify(command),
        options.status ?? "pending",
        "queue",
        1,
        options.uncertain ? 1 : 0,
      ),
  );
}

function setQueue(seam: EngineSeam, thread: string, patch: Record<string, unknown>): void {
  const columns = Object.keys(patch);
  seam.store.atomic((db) =>
    db
      .prepare(
        `UPDATE engine_queue SET ${columns.map((column) => `${column}=?`).join(",")} WHERE thread_id=?`,
      )
      .run(...columns.map((column) => patch[column] as string | number | null), thread),
  );
}

describe.runIf(native)("E5.4d's queue branches", () => {
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

describe.runIf(native)("the shell's receipt", () => {
  test("a null fence and a null host fall through, and an ok calls the commanded hook", async () => {
    const { seam, thread } = await seededQueue();
    try {
      const commanded: unknown[] = [];
      seam.engine.bindOwnershipFence((() => null) as never);
      seam.engine.bindHostInteractions((() => null) as never);
      (
        seam.engine as unknown as { bindCommanded(cb: (command: unknown) => void): void }
      ).bindCommanded((command) => commanded.push(command));
      const revision = seam.engine.queue(thread as never).revision;
      expect(
        seam.engine.handler.handle(
          {
            id: "pause",
            deviceId: "device",
            payload: { type: "queue.pause", threadId: thread, expectedRevision: revision },
          } as never,
          undefined as never,
        ),
      ).toEqual({ commandId: "pause", ok: true });
      expect(commanded).toHaveLength(1);
    } finally {
      await seam.close();
    }
  });

  test("a policy that accepts and then answers null runs the receipt once", async () => {
    const { seam, thread } = await seededQueue();
    try {
      const revision = seam.engine.queue(thread as never).revision;
      seam.engine.bindCommandPolicy(((_command: unknown, accept: () => unknown) => {
        accept();
        return null;
      }) as never);
      // A second run of the same receipt would see the bumped revision and answer
      // `queue_conflict`, and a second bump would show one revision too many.
      expect(
        seam.engine.handler.handle(
          {
            id: "pause",
            deviceId: "device",
            payload: { type: "queue.pause", threadId: thread, expectedRevision: revision },
          } as never,
          undefined as never,
        ),
      ).toEqual({ commandId: "pause", ok: true });
      expect(seam.engine.queue(thread as never).revision).toBe(revision + 1);
    } finally {
      await seam.close();
    }
  });
});

/** A thread row only: readiness has no state to recover, so it settles. */
async function seededRow(options: Partial<EngineOptions> = {}, ready = true) {
  let thread = "";
  const seam = await engineSeam({
    options,
    afterOpen: (store) => {
      const workspace = store.createWorkspace(process.cwd(), "E5.4d");
      thread = createDevThread(store, workspace).id;
    },
  });
  if (ready) await seam.engine.ready();
  else await seam.engine.ready().catch(() => {});
  return { seam, thread };
}

describe.runIf(native)("prepareCommand", () => {
  test("waits for the command's provider and for readiness", async () => {
    const waited: string[] = [];
    const { seam, thread } = await seededRow({
      waitForProvider: async (provider) => {
        waited.push(provider);
      },
    });
    try {
      await seam.engine.prepareCommand(
        Command.parse({
          id: "send",
          deviceId: "device",
          payload: {
            type: "thread.send",
            threadId: thread,
            input: [{ type: "text", text: "hi" }],
          },
        }),
      );
      expect(waited).toEqual(["codex"]);
    } finally {
      await seam.close();
    }
  });

  test("a recovery port it would have to run fails NotPorted naming E5.8", async () => {
    // The preferences port makes the Rust readiness step E5.8's; prepareCommand throws first.
    const { seam, thread } = await seededRow(
      {
        recovery: {
          preferences: () => Promise.resolve({ followUpBehavior: "queue", limitPolicy: "manual" }),
        },
      },
      false,
    );
    try {
      await expect(
        seam.engine.prepareCommand(
          Command.parse({
            id: "resume",
            deviceId: "device",
            payload: { type: "thread.resume", threadId: thread, expectedRevision: 0 },
          }),
        ),
      ).rejects.toThrow("prepareCommand's recovery lands in E5.8");
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
