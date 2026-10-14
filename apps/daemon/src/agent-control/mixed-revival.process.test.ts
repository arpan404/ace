import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import {
  RemoteAgentHost,
  RemoteAgentOperation,
  RemoteTask,
  type DelegationPolicy,
} from "@ace/protocol";
import { DelegationService } from "./delegations.ts";
import { RemoteDelegations } from "./remote.ts";
import { RemoteTaskJournal } from "./remote-journal.ts";
import { setup } from "./test-support.ts";

const cases: { reason: string; policy: Partial<DelegationPolicy>; recovery: boolean }[] = [];
for (const recovery of [false, true])
  for (const [reason, policy] of [
    ["remote sibling concurrency", { maxConcurrent: 1 }],
    ["combined token consumption", { tokens: 30 }],
    ["combined cost consumption", { cost: 1 }],
  ] satisfies [string, Partial<DelegationPolicy>][])
    cases.push({ reason, policy, recovery });

test.each(cases)(
  "revived work respects $reason, including recovery=$recovery",
  async ({ reason, policy, recovery }) => {
    const f = setup(policy);
    const parent = await f.parent();
    f.service.close();
    const ledger = new RemoteTaskJournal(f.store);
    const deps = {
      store: f.store,
      engine: f.engine,
      clock: f.clock,
      models: f.catalog,
      id: randomUUID,
      policy,
      onError: (error: unknown) => f.errors.push(error),
      externalCapacity: (owner: typeof parent.threadId, root: typeof parent.threadId) => ({
        concurrent: ledger.active().filter((task) => task.parentThreadId === owner).length,
        children: ledger.root(root).children,
        usage: ledger.root(root).usage,
      }),
    };
    let service = new DelegationService(deps);
    const remote = new RemoteDelegations({
      store: f.store,
      engine: f.engine,
      local: service,
      hostId: "source",
      now: f.clock.now,
      id: randomUUID,
      admit: () => true,
    });
    try {
      const child = service.delegate(parent, {
        requestId: "local",
        provider: "claude",
        model: "chosen-model",
        task: "Review",
        role: "Reviewer",
        wait: true,
        estimatedLoad: 0,
      });
      await f.engine.flush();
      if (reason !== "remote sibling concurrency")
        await f.emit(child.childId, {
          type: "usage",
          agent: "root",
          inputTokens: 20,
          outputTokens: 0,
          costUsd: 0.75,
          counterMode: "cumulative",
          counterKey: "first",
        });
      await f.complete(child.childId, "First answer");
      await service.wait(parent, child.childId, new AbortController().signal);
      const lease = remote.register(
        "broker",
        [
          RemoteAgentHost.parse({
            hostId: "target",
            name: "Target",
            projects: [{ workspaceId: "project", name: "Project" }],
            agents: [
              {
                provider: "codex",
                model: "chosen-model",
                accessModes: ["read-only", "ask", "auto-review", "full-access"],
              },
            ],
          }),
        ],
        () => true,
      );
      if (!lease) throw new Error("No lease");
      const result = await remote.execute(
        parent,
        RemoteAgentOperation.parse({
          op: "device.delegate",
          requestId: "remote",
          hostId: "target",
          workspaceId: "project",
          provider: "codex",
          model: "chosen-model",
          task: "Review",
          role: "Reviewer",
          mode: "local",
        }),
        new AbortController().signal,
      );
      expect(result.ok).toBe(true);
      const sibling = RemoteTask.parse(result.data);
      remote.poll("broker", lease);
      if (reason !== "remote sibling concurrency")
        expect(
          remote.report("broker", lease, {
            taskId: sibling.id,
            phase: "running",
            usage: { tokens: 10, cost: 0.25 },
          })?.phase,
        ).toBe("running");
      // Close before the provider facts to leave the durable edge settled at restart.
      if (recovery) service.close();
      await f.emit(child.childId, {
        type: "turn.started",
        agent: "root",
        trigger: "background_completion",
      });
      if (recovery) {
        expect(f.store.getThread(child.childId)?.status.state).toBe("working");
        service = new DelegationService(deps);
      }
      await f.engine.flush();
      expect(f.store.getThread(child.childId)?.status.state).toBe("done");
      expect(await service.wait(parent, child.childId, new AbortController().signal)).toMatchObject(
        { outcome: "cancelled" },
      );
      expect(f.errors).toEqual([]);
    } finally {
      remote.close();
      service.close();
    }
  },
);
