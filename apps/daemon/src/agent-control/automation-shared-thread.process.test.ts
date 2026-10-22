import {
  AgentAutomation,
  AutomationInbox,
  AutomationResponse,
  type Automation,
} from "@ace/protocol";
import { expect, test } from "vitest";
import { automationFixture } from "./automation-test-support.ts";

type Fixture = Awaited<ReturnType<typeof automationFixture>>;

const definition = (id: string, prompt: string, workspace: string): Automation => ({
  id,
  title: id,
  enabled: true,
  workspace,
  provider: "claude",
  prompt,
  worktree: false,
  trigger: { kind: "manual" },
  missedRun: "skip",
  concurrency: 1,
  jitterMs: 0,
});

/** Two automations an agent made from its one Claude thread, with the global switch on. */
async function setUp() {
  const f = await automationFixture("claude");
  for (const [id, prompt] of [
    ["alpha", "Run alpha"],
    ["beta", "Run beta"],
  ] as const)
    expect(
      (
        await f.call({
          op: "automation.manage",
          request: {
            type: "automation.put",
            requestId: `put-${id}`,
            automation: AgentAutomation.parse(definition(id, prompt, f.h.home)),
          },
        })
      ).ok,
    ).toBe(true);
  await f.settings.set("automations.enabled", true, { kind: "global" });
  await f.settings.settled({ kind: "global" });
  return f;
}

const run = async (f: Fixture, id: string, requestId: string) =>
  AutomationResponse.parse(
    (
      await f.call({
        op: "automation.manage",
        request: { type: "automation.run", requestId, id, variables: {} },
      })
    ).data,
  );

const latest = async (f: Fixture, id: string) => {
  const inbox = AutomationInbox.parse(
    (
      await f.call({
        op: "automation.manage",
        request: { type: "automation.inbox", requestId: "inbox", limit: 50 },
      })
    ).data,
  );
  return inbox.runs.find((entry) => entry.automationId === id);
};

const setEnabled = (f: Fixture, id: string, enabled: boolean) =>
  f.call({
    op: "automation.manage",
    request: { type: "automation.setEnabled", requestId: `enabled-${id}-${enabled}`, id, enabled },
  });

const thread = (f: Fixture) => f.h.store.getThread(f.caller.threadId);

test("pausing one automation takes out only its queued message and leaves another's turn going", async () => {
  const f = await setUp();
  try {
    await run(f, "beta", "beta-1");
    await expect.poll(() => f.h.inputs.get(f.caller.threadId)?.at(-1)).toBe("Run beta");
    await run(f, "alpha", "alpha-1");
    await f.h.engine.flush();
    expect((await latest(f, "alpha"))?.status).toBe("running");
    await setEnabled(f, "alpha", false);
    await expect
      .poll(() => latest(f, "alpha"))
      .toMatchObject({ status: "failed", result: "Stopped before it started." });
    // Beta's turn goes on as its own, and alpha's message never reaches the agent.
    expect(thread(f)?.status.state).toBe("working");
    expect((await latest(f, "beta"))?.status).toBe("running");
    await f.answer(3, "beta-answer", "Beta is done.");
    await expect
      .poll(() => latest(f, "beta"))
      .toMatchObject({ status: "succeeded", result: "Beta is done." });
    expect(f.h.inputs.get(f.caller.threadId)).toEqual(["plan", "Run beta"]);
  } finally {
    await f.close();
  }
});

test("a run keeps its own turn's answer though another turn starts right after it", async () => {
  const f = await setUp();
  try {
    await run(f, "alpha", "alpha-1");
    await expect.poll(() => f.h.inputs.get(f.caller.threadId)?.at(-1)).toBe("Run alpha");
    await run(f, "beta", "beta-1");
    await f.answer(2, "alpha-answer", "Alpha found two bugs.");
    // Beta's message starts the next turn at once.
    await expect.poll(() => f.h.inputs.get(f.caller.threadId)?.at(-1)).toBe("Run beta");
    await expect
      .poll(() => latest(f, "alpha"))
      .toMatchObject({ status: "succeeded", result: "Alpha found two bugs." });
    // Pausing alpha now stops nothing: the turn running is beta's.
    await setEnabled(f, "alpha", false);
    await f.h.engine.flush();
    expect(thread(f)?.status.state).toBe("working");
    await f.answer(3, "beta-answer", "Beta found none.");
    await expect
      .poll(() => latest(f, "beta"))
      .toMatchObject({ status: "succeeded", result: "Beta found none." });
    expect((await latest(f, "alpha"))?.result).toBe("Alpha found two bugs.");
  } finally {
    await f.close();
  }
});

test("pausing a run in its own turn stops it, and after resuming the next run reaches the thread", async () => {
  const f = await setUp();
  try {
    await run(f, "alpha", "alpha-1");
    await expect.poll(() => f.h.inputs.get(f.caller.threadId)?.at(-1)).toBe("Run alpha");
    await setEnabled(f, "alpha", false);
    await expect
      .poll(() => latest(f, "alpha"))
      .toMatchObject({ status: "failed", result: "Stopped before it finished." });
    expect(thread(f)?.status.state).not.toBe("working");
    await setEnabled(f, "alpha", true);
    expect(await run(f, "alpha", "alpha-2")).toMatchObject({
      ok: true,
      run: { status: "running" },
    });
    // The automation's own stop left nothing holding its later runs back.
    await expect
      .poll(() => f.h.inputs.get(f.caller.threadId))
      .toEqual(["plan", "Run alpha", "Run alpha"]);
    await f.answer(3, "alpha-again", "Alpha ran again.");
    await expect
      .poll(() => latest(f, "alpha"))
      .toMatchObject({ status: "succeeded", result: "Alpha ran again." });
  } finally {
    await f.close();
  }
});
