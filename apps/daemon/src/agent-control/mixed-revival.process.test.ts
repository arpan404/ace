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

test.each([false, true])(
  "revived work respects remote sibling concurrency, including recovery=%s",
  async (recovery) => {
    const policy: Partial<DelegationPolicy> = { maxConcurrent: 1 };
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
      RemoteTask.parse(result.data);
      remote.poll("broker", lease);
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
