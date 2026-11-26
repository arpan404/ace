// SPDX-License-Identifier: Apache-2.0
/**
 * The receipt's ports and the shell around them (E5.4d): the provider admission calls, the
 * shell's fence and policy, `prepareCommand`'s waits and the maintenance gate.
 */
import { describe, expect, test } from "vitest";
import { Command } from "@ace/protocol";
import { engineSeam } from "./testing.ts";
import { codexRegistry, native, seededQueue, seededRow } from "./commands-support.ts";

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

  test("a throwing selectInstance port rolls the receipt back", async () => {
    const { seam, thread } = await seededQueue({
      registry: codexRegistry(),
      selectInstance: () => {
        throw new Error("select failed");
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
      ).toThrow("select failed");
      expect(seam.engine.queue(thread as never).revision).toBe(revision);
      expect(seam.store.headSeq()).toBe(seq);
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

describe.runIf(native)("prepareCommand", () => {
  test("archive and interrupt run neither shell wait under a production-like config", async () => {
    // A production daemon gives the silence and preferences ports. Readiness itself still
    // fails here (E5.8's stub), so the check is that neither type wait ran: the silence
    // resolver was never called and the failure is readiness', not `prepareCommand's`.
    const resolved: unknown[] = [];
    const { seam, thread } = await seededRow(
      {
        resolveSilenceMs: async (scope) => {
          resolved.push(scope);
          return 1_000;
        },
        recovery: {
          preferences: async () => ({ followUpBehavior: "queue", limitPolicy: "manual" }),
        },
      },
      false,
    );
    try {
      for (const payload of [
        { type: "thread.archive", threadId: thread },
        { type: "thread.interrupt", threadId: thread },
      ])
        await expect(
          seam.engine.prepareCommand(
            Command.parse({ id: payload.type, deviceId: "device", payload }),
          ),
        ).rejects.toThrow("the recovery preparation lands in E5.8");
      expect(resolved).toEqual([]);
    } finally {
      await seam.close();
    }
  });

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
      ).rejects.toThrow("lands in E5.8");
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

  test("a throwing admits port reaches the caller instead of closing the gate", async () => {
    const seam = await engineSeam({
      options: {
        recovery: {
          admits: () => {
            throw new Error("gate failed");
          },
        },
      } as never,
    });
    try {
      expect(() => seam.engine.admissionReopened()).toThrow("gate failed");
    } finally {
      await seam.close();
    }
  });
});
