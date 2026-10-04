import { expect, test } from "vitest";
import { Agent } from "@ace/protocol";
import { setup, ready, when, barrier } from "./test-support.ts";
// Mutation case: omit deletion keys when admitting a new agent. Not executed (tests run at merge).
test("individual agent usage and context readers clear when a settled agent is evicted", async () => {
  const h = await setup();
  try {
    const agent = Agent.parse({
      id: "evicted",
      threadId: h.thread.id,
      parentId: null,
      origin: "provider_subagent",
      native: { provider: "codex" },
      fidelity: "full",
      cwd: h.directory,
      createdAt: 1,
      status: { state: "idle" },
    });
    h.daemon.store.appendEvents(h.thread.id, [
      { type: "agent.created", agent },
      { type: "usage.updated", agentId: agent.id, inputTokens: 3, outputTokens: 5 },
      {
        type: "context_meter.updated",
        meter: {
          agentId: agent.id,
          epoch: 0,
          usedTokens: 8,
          windowTokens: 1000,
          source: "provider",
        },
      },
    ]);
    const { client } = h.make({ limits: { entities: 1 } });
    await ready(client);
    const lease = client.thread(h.thread.id);
    const agentReader = lease.store.select([`agent:${agent.id}`], (reader) =>
      reader.agent(agent.id),
    );
    const usageReader = lease.store.select([`usage:${agent.id}`], (reader) =>
      reader.usage(agent.id),
    );
    const contextReader = lease.store.select([`context:${agent.id}`], (reader) =>
      reader.contextMeter(agent.id),
    );
    await when(agentReader, Boolean);
    expect(usageReader.getSnapshot()?.outputTokens).toBe(5);
    expect(contextReader.getSnapshot()?.usedTokens).toBe(8);
    // Keep the selectors subscribed so stale cached snapshots are observable.
    const stops = [agentReader, usageReader, contextReader].map((selection) =>
      selection.subscribe(() => {}),
    );
    h.daemon.store.appendEvents(h.thread.id, [
      {
        type: "agent.created",
        agent: Agent.parse({
          ...agent,
          id: "replacement",
          status: { state: "working", activity: "thinking" },
        }),
      },
    ]);
    await barrier(client, h.thread.id);
    expect(agentReader.getSnapshot()).toBeUndefined();
    expect(usageReader.getSnapshot()).toBeUndefined();
    expect(contextReader.getSnapshot()).toBeUndefined();
    for (const stop of stops) stop();
    lease.release();
  } finally {
    await h.cleanup();
  }
});
