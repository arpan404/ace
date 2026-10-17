import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { OffshiftView, type OffshiftRequest } from "@ace/protocol/offshift";
import { createAgentControlPort } from "./tools.ts";
import { daemonFixture } from "./daemon-test-support.ts";
import { question } from "../engine/test-support.ts";

const execute = promisify(execFile);
test("native Offshift rejects stale source evidence, isolates callers and observes delegated human waits", async () => {
  const f = await daemonFixture();
  try {
    await execute("git", ["init"], { cwd: f.h.home });
    await writeFile(join(f.h.home, ".gitignore"), "*\n!.gitignore\n!work.txt\n");
    await writeFile(join(f.h.home, "work.txt"), "before");
    const call = (request: OffshiftRequest) => f.call({ op: "offshift", request });
    const started = await call({
      action: "start",
      runId: "native",
      requestId: "start",
      outcome: "Verified edit",
      endpoint: "local",
      criteria: [{ id: "behavior", description: "Edit works", requiredKinds: ["source"] }],
    });
    expect(started.ok).toBe(true);
    const before = OffshiftView.parse(started.data);
    await writeFile(join(f.h.home, "work.txt"), "after");
    const stale = await call({
      action: "evidence",
      runId: "native",
      requestId: "check",
      version: 0,
      evidence: {
        criterionId: "behavior",
        kind: "source",
        result: "pass",
        revision: before.revision,
        action: "Read diff",
        artifact: "report",
        note: "Inspected change",
      },
    });
    expect(stale).toMatchObject({ ok: false, code: "invalid" });
    const current = OffshiftView.parse((await call({ action: "get", runId: "native" })).data);
    expect(current.revision).not.toBe(before.revision);
    expect(current.pending).toEqual([{ criterionId: "behavior", kind: "source" }]);
    const child = await f.controls.delegations.delegate(f.caller, {
      requestId: "child",
      role: "Check-native-Offshift-human-wait",
      task: "review",
      provider: "codex",
      estimatedLoad: 0,
      wait: false,
    });
    await f.daemon.engine?.flush();
    const childThread = f.daemon.store.getThread(child.childId);
    if (!childThread?.rootAgentId) throw new Error("Missing child");
    const caller = {
      sessionId: "child",
      threadId: child.childId,
      agentId: childThread.rootAgentId,
    };
    expect(
      await f.controls.port.execute(
        caller,
        { op: "offshift", request: { action: "get", runId: "native" } },
        new AbortController().signal,
      ),
    ).toMatchObject({ ok: false, code: "invalid" });
    // The tool remains capability-gated and does not accept caller-selected ownership.
    const unowned = createAgentControlPort(f.daemon.store, f.controls.delegations);
    expect(
      await unowned.execute(
        { ...f.caller, agentId: caller.agentId },
        { op: "offshift", request: { action: "list" } },
        new AbortController().signal,
      ),
    ).toEqual({ ok: false, code: "forbidden" });
    await f.h.emit(child.childId, question);
    await f.daemon.engine?.flush();
    const waiting = OffshiftView.parse((await call({ action: "get", runId: "native" })).data);
    expect(waiting.treeState).toBe("needs_you");
    expect(waiting.state).not.toBe("complete");
  } finally {
    await f.daemon.close();
  }
});
