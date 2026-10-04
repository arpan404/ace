import { expect, test } from "vitest";
import { Agent } from "@ace/protocol";
import { storeFixture, root, start, end, turns } from "./long-thread-test-support.ts";
// Cross-PR #90 mutation: treating restored metadata as a new spawn changes the agent's
// original turn attribution. Not executed (tests run at merge).
test("restoring a historical branch leaves its original turn attribution intact", () => {
  const f = storeFixture();
  start(f.store, f.thread, "first", 20);
  const child = Agent.parse({
    id: "historical-child",
    threadId: f.thread.id,
    parentId: root,
    origin: "provider_subagent",
    fidelity: "full",
    native: { provider: "codex" },
    cwd: f.home,
    status: { state: "idle" },
    createdAt: 21,
  });
  f.store.appendEvents(f.thread.id, [{ type: "agent.created", agent: child }], 21);
  end(f.store, f.thread, "first", 30);
  start(f.store, f.thread, "second", 40);
  f.store.appendEvents(
    f.thread.id,
    [
      { type: "agent.created", agent: child },
      {
        type: "agent.status",
        agentId: child.id,
        status: { state: "working", activity: "thinking" },
      },
    ],
    41,
  );
  const page = turns(f.store, f.thread);
  const first = page.turns.find((turn) => turn.ordinal === 1);
  const second = page.turns.find((turn) => turn.ordinal === 2);
  expect(first?.subagents.some((agent) => agent.agentId === child.id)).toBe(true);
  expect(second?.subagents.some((agent) => agent.agentId === child.id)).toBe(false);
  expect(first?.status.state).toBe("working");
});
