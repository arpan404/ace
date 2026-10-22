import { AutomationResponse, type Automation, AgentAutomation } from "@ace/protocol";
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
            request: {
              type: "automation.put",
              requestId: `put-${automation.id}`,
              automation: AgentAutomation.parse(automation),
            },
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
            automation: AgentAutomation.parse({ ...base, id: "invalid-0" }),
          },
        },
        { sessionId: "foreign", threadId: foreign.threadId, agentId },
      ),
    ).toEqual({ ok: false, code: "forbidden" });
  } finally {
    await f.close();
  }
});

test("agents cannot pause, resume, or retry jobs they do not own", async () => {
  const f = await automationFixture();
  try {
    const base: Automation = {
      id: "owned-pause",
      title: "Owned",
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
    const manage = (request: import("@ace/protocol").AgentAutomationRequest) =>
      f.call({ op: "automation.manage", request });
    expect(
      await manage({
        type: "automation.put",
        requestId: "own-put",
        automation: AgentAutomation.parse(base),
      }),
    ).toMatchObject({ ok: true });
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
    const outsider = { sessionId: "foreign", threadId: foreign.threadId, agentId };
    expect(
      await f.call(
        {
          op: "automation.manage",
          request: {
            type: "automation.setEnabled",
            requestId: "pause-foreign",
            id: base.id,
            enabled: false,
          },
        },
        outsider,
      ),
    ).toEqual({ ok: false, code: "forbidden" });
    expect(
      await f.call(
        {
          op: "automation.manage",
          request: { type: "automation.retry", requestId: "retry-foreign", id: base.id },
        },
        outsider,
      ),
    ).toEqual({ ok: false, code: "forbidden" });
    expect(
      await f.call(
        {
          op: "automation.manage",
          request: { type: "automation.remove", requestId: "remove-foreign", id: base.id },
        },
        outsider,
      ),
    ).toEqual({ ok: false, code: "forbidden" });
    expect(
      await f.call(
        {
          op: "automation.manage",
          request: {
            type: "automation.setEnabled",
            requestId: "pause-missing",
            id: "absent",
            enabled: false,
          },
        },
        outsider,
      ),
    ).toEqual({ ok: false, code: "not_found" });
    expect(
      await f.call({
        op: "automation.manage",
        request: { type: "automation.retry", requestId: "retry-missing", id: "absent" },
      }),
    ).toEqual({ ok: false, code: "not_found" });
    expect(
      await manage({
        type: "automation.setEnabled",
        requestId: "pause-own",
        id: base.id,
        enabled: false,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await manage({
        type: "automation.setEnabled",
        requestId: "resume-own",
        id: base.id,
        enabled: true,
      }),
    ).toMatchObject({ ok: true });
    await f.settings.set("automations.enabled", true, { kind: "global" });
    await f.settings.settled({ kind: "global" });
    expect(
      await manage({ type: "automation.retry", requestId: "retry-own", id: base.id }),
    ).toMatchObject({ ok: true });
    expect(
      await manage({
        type: "automation.setEnabled",
        requestId: "stale-own",
        id: base.id,
        enabled: false,
        expectedRevision: 999_999,
      }),
    ).toMatchObject({ ok: false });
  } finally {
    await f.close();
  }
});
