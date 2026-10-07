import { expect, test } from "vitest";
import { Automation } from "@ace/protocol";
import { automationExecutor } from "./automation-executor.ts";
import { transitionHarness } from "./engine/transition-test-support.ts";
import { createLogger } from "@ace/diagnostics";
import { readConfig } from "./config.ts";
import { Resources } from "./services/resources.ts";

test("an existing Cursor automation launches on SDK and recovery keeps the same thread", async () => {
  const h = transitionHarness({ configure: false });
  const resources = new Resources();
  const log = createLogger({
    now: () => h.clock.now(),
    redact: (value) => value,
    sink: { write: async () => {}, close: async () => {} },
  });
  try {
    const automation = Automation.parse({
      id: "cursor-job",
      title: "Cursor work",
      enabled: true,
      workspace: h.workspace,
      provider: "cursor",
      prompt: "Scheduled work",
      worktree: false,
      trigger: { kind: "manual" },
      missedRun: "skip",
      concurrency: 1,
      jitterMs: 0,
    });
    const executor = () =>
      automationExecutor({
        store: h.store,
        services: { engine: h.engine },
        config: readConfig({ ACE_HOME: h.home }, h.home),
        options: {},
        signal: new AbortController().signal,
        resources,
        now: () => h.clock.now(),
        id: () => "unused",
        log,
        onListen: [],
      });
    const signal = new AbortController().signal;
    const work = executor().execute(
      { ...automation, automationId: automation.id, idempotencyKey: "existing-run" },
      signal,
    );
    await h.engine.flush();
    const result = await work;
    expect(result.status).toBe("succeeded");
    expect(h.store.listThreads()).toEqual([
      expect.objectContaining({ id: result.threadId, provider: "cursor", backend: "cursor-sdk" }),
    ]);
    expect(h.inputs.map((input) => input.text)).toEqual(["Scheduled work"]);
    await h.restart();
    expect(await executor().recover("existing-run", signal)).toMatchObject({
      threadId: result.threadId,
      status: "succeeded",
    });
    expect(h.inputs).toHaveLength(1);
  } finally {
    await resources.close();
    await log.close();
    await h.close();
  }
});
