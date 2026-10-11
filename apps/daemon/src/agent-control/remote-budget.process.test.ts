import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentControlOperation } from "@ace/protocol";
import { expect, test } from "vitest";
import { DelegationService } from "./delegations.ts";
import { remoteTarget } from "./remote-target-test-support.ts";

test("an incoming task cannot reset source child/depth authority through any local child admission", async () => {
  const f = await remoteTarget({ maxChildren: 1, maxDepth: 1 });
  const before = f.target.daemon.store.listThreads().length;
  const operations: AgentControlOperation[] = [
    {
      op: "delegate_task",
      requestId: "delegate",
      provider: "claude",
      model: "chosen-model",
      role: "Worker",
      task: "Work",
      wait: false,
      estimatedLoad: 0,
    },
    {
      op: "thread.create",
      requestId: "create",
      provider: "claude",
      model: "chosen-model",
      title: "Worker",
    },
    {
      op: "thread.handoff",
      requestId: "handoff",
      threadId: f.task.threadId,
      branch: "unauthorized-child",
    },
  ];
  for (const operation of operations)
    await expect(
      f.target.controls.port.execute(f.caller, operation, new AbortController().signal),
    ).rejects.toMatchObject({ code: "delegation_denied" });
  expect(f.target.daemon.store.listThreads()).toHaveLength(before);
  const directory = join(f.target.h.home, "daemon", "agent-worktrees");
  expect(await readdir(directory).catch(() => [])).toEqual([]);
  const recovered = new DelegationService({
    store: f.target.daemon.store,
    engine: f.target.daemon.engine!,
    models: f.target.daemon.models,
    clock: f.target.h.clock,
    id: () => "new-child",
    onError: () => {},
  });
  try {
    expect(() =>
      recovered.delegate(f.caller, {
        requestId: "after-restart",
        provider: "claude",
        model: "chosen-model",
        role: "Worker",
        task: "Work",
        wait: false,
        estimatedLoad: 0,
      }),
    ).toThrow(/source.*budget/i);
    const unrelated = recovered.delegate(f.target.caller, {
      requestId: "unrelated",
      provider: "claude",
      model: "chosen-model",
      role: "Worker",
      task: "Work",
      wait: false,
      estimatedLoad: 0,
    });
    await f.target.daemon.engine?.flush();
    expect(f.target.daemon.store.getThread(unrelated.childId)?.status.state).toBe("working");
  } finally {
    recovered.close();
  }
});
