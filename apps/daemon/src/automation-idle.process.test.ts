import { setTimeout as delay } from "node:timers/promises";
import { test } from "vitest";
import { z } from "zod";
import { idleDaemon } from "./automation-idle-test-support.ts";

test.concurrent(
  "an empty daemon repeats a saved prompt with every client disconnected",
  { timeout: 180_000 },
  async ({ expect }) => {
    const f = await idleDaemon();
    try {
      let connection = await f.connect();
      const automation = f.definition(
        "idle-scheduled-prompt",
        Math.ceil((Date.now() + 2000) / 60_000) * 60_000,
      );
      if (automation.trigger.kind !== "schedule") throw new Error("Expected schedule");
      automation.trigger.schedule.expression = "FREQ=MINUTELY;COUNT=2";
      expect(
        await connection.ask({
          type: "automation.put",
          requestId: "save",
          automation,
          expectedRevision: null,
        }),
      ).toMatchObject({ ok: true });
      await f.disconnect();
      await expect.poll(() => f.prompts, { timeout: 65_000 }).toEqual([automation.prompt]);
      await expect
        .poll(() => f.prompts, { timeout: 65_000 })
        .toEqual([automation.prompt, automation.prompt]);
      connection = await f.connect();
      await expect
        .poll(
          async () =>
            (
              await connection.ask({
                type: "automation.inbox",
                requestId: "history",
                automationId: automation.id,
                limit: 50,
              })
            ).inbox?.runs,
        )
        .toMatchObject([
          { status: "succeeded", trigger: "schedule", result: "Scheduled task completed" },
          { status: "succeeded", trigger: "schedule", result: "Scheduled task completed" },
        ]);
      // Both runs are turns of the automation's one thread.
      expect(f.daemon.store.listThreads()).toHaveLength(1);
      const saved = await connection.ask({ type: "automation.list", requestId: "finished" });
      expect(saved.schedules?.[0]).toMatchObject({
        nextRunAt: null,
        lastRun: { status: "succeeded" },
      });
      expect(saved.schedules?.[0]?.triggerError).toBeUndefined();
    } finally {
      await f.close();
    }
  },
);

test.concurrent(
  "pause survives restart, suppresses the deadline, and resume executes the edited prompt",
  { timeout: 180_000 },
  async ({ expect }) => {
    const f = await idleDaemon();
    try {
      let connection = await f.connect();
      const due = Math.ceil((Date.now() + 2000) / 60_000) * 60_000;
      const automation = f.definition("paused-schedule", due);
      expect(
        await connection.ask({
          type: "automation.put",
          requestId: "save",
          automation,
          expectedRevision: null,
        }),
      ).toMatchObject({ ok: true });
      const before = await connection.ask({ type: "automation.list", requestId: "before-pause" });
      expect(
        await connection.ask({
          type: "automation.setEnabled",
          requestId: "pause",
          id: automation.id,
          enabled: false,
          expectedRevision: z.number().parse(before.schedules?.[0]?.revision),
        }),
      ).toMatchObject({ ok: true });
      await f.restart();
      await delay(Math.max(0, due - Date.now()) + 150);
      expect(f.prompts).toEqual([]);
      expect(f.daemon.store.listThreads()).toEqual([]);
      connection = await f.connect();
      const paused = await connection.ask({
        type: "automation.list",
        requestId: "paused-after-restart",
      });
      expect(paused.automations).toEqual([{ ...automation, enabled: false }]);
      expect(paused.schedules?.[0]?.nextRunAt).toBeNull();
      const edited = {
        ...f.definition(automation.id, Math.ceil((Date.now() + 2000) / 60_000) * 60_000),
        enabled: false,
        prompt: "Summarize failed tests using the updated saved instructions",
      };
      expect(
        await connection.ask({
          type: "automation.put",
          requestId: "edit",
          automation: edited,
          expectedRevision: z.number().parse(paused.schedules?.[0]?.revision),
        }),
      ).toMatchObject({ ok: true });
      const saved = await connection.ask({ type: "automation.list", requestId: "saved-edit" });
      expect(
        await connection.ask({
          type: "automation.setEnabled",
          requestId: "resume",
          id: automation.id,
          enabled: true,
          expectedRevision: z.number().parse(saved.schedules?.[0]?.revision),
        }),
      ).toMatchObject({ ok: true });
      await f.disconnect();
      await expect.poll(() => f.prompts, { timeout: 65_000 }).toEqual([edited.prompt]);
      connection = await f.connect();
      await expect
        .poll(
          async () =>
            (
              await connection.ask({
                type: "automation.inbox",
                requestId: "completed",
                automationId: automation.id,
                limit: 50,
              })
            ).inbox?.runs,
        )
        .toMatchObject([{ status: "succeeded" }]);
      expect(f.daemon.store.listThreads()).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
);

test.concurrent.for(["run_once", "skip"] as const)(
  "restart applies %s to a missed deadline even with a broken file trigger",
  async (missedRun, { expect }) => {
    const f = await idleDaemon();
    try {
      let connection = await f.connect();
      const due = Math.ceil((Date.now() + 2000) / 60_000) * 60_000;
      const automation = { ...f.definition("missed-schedule", due), missedRun };
      const broken = {
        ...f.definition("broken-file-trigger", due),
        workspace: "missing-workspace",
        trigger: { kind: "file" as const, paths: ["**/*.ts"] },
      };
      expect(
        await connection.ask({
          type: "automation.put",
          requestId: "broken",
          automation: broken,
          expectedRevision: null,
        }),
      ).toMatchObject({ ok: true });
      expect(
        await connection.ask({
          type: "automation.put",
          requestId: "save",
          automation,
          expectedRevision: null,
        }),
      ).toMatchObject({ ok: true });
      await f.stop();
      await delay(Math.max(0, due - Date.now()) + 150);
      await f.restart();
      connection = await f.connect();
      const snapshot = await connection.ask({ type: "automation.list", requestId: "recovered" });
      expect(
        snapshot.schedules?.find((schedule) => schedule.id === broken.id)?.triggerError?.message,
      ).toMatch(/workspace/i);
      if (missedRun === "run_once") {
        await expect.poll(() => f.prompts, { timeout: 65_000 }).toEqual([automation.prompt]);
        await expect
          .poll(
            async () =>
              (
                await connection.ask({
                  type: "automation.inbox",
                  requestId: "history",
                  automationId: automation.id,
                  limit: 50,
                })
              ).inbox?.runs,
          )
          .toMatchObject([{ status: "succeeded" }]);
      } else {
        expect(
          snapshot.schedules?.find((schedule) => schedule.id === automation.id)?.nextRunAt,
        ).toBeNull();
        await delay(200);
        expect(f.prompts).toEqual([]);
        expect(f.daemon.store.listThreads()).toEqual([]);
      }
    } finally {
      await f.close();
    }
  },
);

test.concurrent("a manual retry and a committed deletion survive daemon restart without another execution", async ({
  expect,
}) => {
  const f = await idleDaemon();
  try {
    let connection = await f.connect();
    const automation = {
      ...f.definition("manual-retry", Math.floor(Date.now() / 60_000) * 60_000),
      trigger: { kind: "manual" as const },
    };
    expect(
      await connection.ask({
        type: "automation.put",
        requestId: "save",
        automation,
        expectedRevision: null,
      }),
    ).toMatchObject({ ok: true });
    const intent = {
      type: "automation.run" as const,
      requestId: "one-user-intent",
      id: automation.id,
      variables: {},
    };
    const first = await connection.ask(intent);
    const runId = z.string().parse(first.run?.id);
    await expect
      .poll(
        async () =>
          (
            await connection.ask({
              type: "automation.inbox",
              requestId: "history",
              automationId: automation.id,
              limit: 50,
            })
          ).inbox?.runs,
        { timeout: 15_000 },
      )
      .toMatchObject([{ id: runId, status: "succeeded" }]);
    await f.restart();
    connection = await f.connect();
    expect((await connection.ask(intent)).run?.id).toBe(runId);
    expect(f.prompts).toEqual([automation.prompt]);
    expect(f.daemon.store.listThreads()).toHaveLength(1);
    const saved = await connection.ask({ type: "automation.list", requestId: "saved" });
    expect(
      await connection.ask({
        type: "automation.remove",
        requestId: "delete",
        id: automation.id,
        expectedRevision: z.number().parse(saved.schedules?.[0]?.revision),
      }),
    ).toMatchObject({ ok: true });
    await f.restart();
    connection = await f.connect();
    expect(await connection.ask({ type: "automation.list", requestId: "deleted" })).toMatchObject({
      ok: true,
      automations: [],
    });
    expect(await connection.ask({ ...intent, requestId: "new-intent-after-delete" })).toMatchObject(
      { ok: false },
    );
    expect(f.prompts).toEqual([automation.prompt]);
    expect(f.daemon.store.listThreads()).toHaveLength(1);
  } finally {
    await f.close();
  }
});
