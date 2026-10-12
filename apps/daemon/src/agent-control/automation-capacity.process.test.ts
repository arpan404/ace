import { AutomationResponse, type Automation } from "@ace/protocol";
import { expect, test } from "vitest";
import { automationFixture } from "./automation-test-support.ts";

test("removed and rejected agent definitions do not permanently consume automation capacity", async () => {
  const f = await automationFixture();
  try {
    const base: Automation = {
      id: "job",
      title: "Job",
      enabled: true,
      workspace: f.h.home,
      provider: "codex",
      prompt: "Check",
      worktree: false,
      trigger: { kind: "manual" },
      missedRun: "skip",
      concurrency: 1,
      jitterMs: 0,
    };
    const put = async (automation: Automation) =>
      AutomationResponse.parse(
        (
          await f.call({
            op: "automation.manage",
            request: { type: "automation.put", requestId: `put-${automation.id}`, automation },
          })
        ).data,
      );
    for (let i = 0; i < 1001; i++) {
      const automation = { ...base, id: `cycle-${i}` };
      expect((await put(automation)).ok).toBe(true);
      expect(
        (
          await f.call({
            op: "automation.manage",
            request: { type: "automation.remove", requestId: `remove-${i}`, id: automation.id },
          })
        ).ok,
      ).toBe(true);
    }
    for (let i = 0; i < 1001; i++) {
      const automation: Automation = {
        ...base,
        id: `invalid-${i}`,
        trigger: {
          kind: "schedule",
          schedule: { kind: "rrule", expression: "FREQ=INVALID", timezone: "UTC", startAt: 60_000 },
        },
      };
      expect(await put(automation)).toMatchObject({ ok: false });
    }
    expect((await put({ ...base, id: "after-churn" })).ok).toBe(true);
    expect(
      (
        await f.call({
          op: "automation.manage",
          request: { type: "automation.list", requestId: "list" },
        })
      ).data,
    ).toMatchObject([{ id: "after-churn" }]);
    for (let i = 0; i < 999; i++) expect((await put({ ...base, id: `live-${i}` })).ok).toBe(true);
    expect(await put({ ...base, id: "over-cap" })).toMatchObject({
      ok: false,
      error: "Automation limit reached",
    });
    await f.call({
      op: "automation.manage",
      request: { type: "automation.remove", requestId: "free-slot", id: "live-0" },
    });
    expect((await put({ ...base, id: "replacement" })).ok).toBe(true);
    // A failed claim keeps its authorization tombstone despite releasing live capacity.
    const workspaceId = f.h.store.getThread(f.caller.threadId)?.workspaceId;
    if (!workspaceId) throw new Error("Missing caller workspace");
    const foreign = f.h.service.command("foreign", {
      type: "thread.create",
      workspaceId,
      provider: "codex",
      input: [{ type: "text", text: "Other caller" }],
    });
    await f.h.engine.flush();
    if (!foreign.threadId) throw new Error("Missing foreign thread");
    const agentId = f.h.store.getThread(foreign.threadId)?.rootAgentId;
    if (!agentId) throw new Error("Missing foreign root");
    await f.restart();
    expect(
      await f.call(
        {
          op: "automation.manage",
          request: {
            type: "automation.put",
            requestId: "steal",
            automation: { ...base, id: "invalid-0" },
          },
        },
        { sessionId: "foreign", threadId: foreign.threadId, agentId },
      ),
    ).toEqual({ ok: false, code: "forbidden" });
  } finally {
    await f.close();
  }
});
