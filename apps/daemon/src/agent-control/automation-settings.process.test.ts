import { AutomationResponse, type Automation, AgentAutomation } from "@ace/protocol";
import { expect, test } from "vitest";
import { automationFixture } from "./automation-test-support.ts";

function definition(workspace: string): Automation {
  return {
    id: "owned-switch",
    title: "Check",
    enabled: true,
    workspace,
    provider: "claude",
    prompt: "Check",
    worktree: false,
    trigger: { kind: "manual" },
    missedRun: "run_once",
    concurrency: 1,
    jitterMs: 0,
  };
}

test("agent manual runs follow the global automation switch, and turning it off never fails a run", async () => {
  const f = await automationFixture();
  try {
    const automation = definition(f.h.home);
    expect(
      (
        await f.call({
          op: "automation.manage",
          request: {
            type: "automation.put",
            requestId: "put",
            automation: AgentAutomation.parse(automation),
          },
        })
      ).ok,
    ).toBe(true);
    const run = async (requestId: string) =>
      AutomationResponse.parse(
        (
          await f.call({
            op: "automation.manage",
            request: { type: "automation.run", requestId, id: automation.id, variables: {} },
          })
        ).data,
      );
    expect(await run("disabled")).toMatchObject({
      ok: false,
      error: "Automation service is stopped",
    });
    await f.settings.set("automations.enabled", true, { kind: "global" });
    await f.settings.settled({ kind: "global" });
    const admitted = await run("enabled");
    expect(admitted).toMatchObject({ ok: true, run: { status: "running" } });
    if (!admitted.run) throw new Error("Missing run");
    // The run is a message into the agent's own thread.
    await expect.poll(() => f.h.inputs.get(f.caller.threadId)?.at(-1)).toBe("Check");
    await f.h.engine.flush();
    await f.settings.set("automations.enabled", false, { kind: "global" });
    await f.settings.settled({ kind: "global" });
    expect(await run("disabled-again")).toMatchObject({
      ok: false,
      error: "Automation service is stopped",
    });
    const inbox = await f.call({
      op: "automation.manage",
      request: { type: "automation.inbox", requestId: "inbox", limit: 50 },
    });
    // Turning the service off never fails a run: this one finished its turn in the thread.
    expect(inbox.data).toMatchObject({ runs: [{ status: "succeeded" }] });
    await f.settings.set("automations.enabled", true, { kind: "global" });
    await f.settings.settled({ kind: "global" });
    expect(await run("resumed")).toMatchObject({ ok: true, run: { status: "running" } });
  } finally {
    await f.close();
  }
});

test("persisted agent schedules stay stopped across restart and resume the missed occurrence when enabled", async () => {
  const f = await automationFixture();
  try {
    const automation: Automation = {
      ...definition(f.h.home),
      trigger: {
        kind: "schedule",
        schedule: {
          kind: "rrule",
          expression: "FREQ=MINUTELY;COUNT=1",
          timezone: "UTC",
          startAt: 60_000,
        },
      },
    };
    expect(
      (
        await f.call({
          op: "automation.manage",
          request: {
            type: "automation.put",
            requestId: "scheduled",
            automation: AgentAutomation.parse(automation),
          },
        })
      ).ok,
    ).toBe(true);
    await f.restart();
    const inbox = async () =>
      (
        await f.call({
          op: "automation.manage",
          request: { type: "automation.inbox", requestId: "inbox", limit: 50 },
        })
      ).data;
    f.h.clock.advance(60_000);
    expect(await inbox()).toMatchObject({ runs: [] });
    await f.settings.set("automations.enabled", true, { kind: "global" });
    await f.settings.settled({ kind: "global" });
    await f.settings.set("automations.enabled", false, { kind: "global" });
    await f.settings.settled({ kind: "global" });
    f.h.clock.advance(120_000);
    expect(await inbox()).toMatchObject({ runs: [] });
    await f.settings.set("automations.enabled", true, { kind: "global" });
    await f.settings.settled({ kind: "global" });
    f.h.clock.advance(120_000);
    await expect
      .poll(inbox)
      .toMatchObject({ runs: [{ status: "running", eventKey: "schedule:60000" }] });
    // The caught-up run is a message into the agent's own thread.
    await expect.poll(() => f.h.inputs.get(f.caller.threadId)?.at(-1)).toBe("Check");
  } finally {
    await f.close();
  }
});
