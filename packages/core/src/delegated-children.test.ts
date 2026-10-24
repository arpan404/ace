import type { ThreadStatus } from "@ace/protocol";
import { expect, it } from "vitest";
import { deriveThreadStatus } from "./index.ts";
import { endedRoot } from "./status-test-helper.ts";

/** A parent whose turn ended, following children ace delegated in threads of their own. */
function parentWith(children: Record<string, ThreadStatus>) {
  const h = endedRoot();
  for (const [child, status] of Object.entries(children)) {
    h.send({
      type: "agent.seen",
      agent: child,
      parent: "root",
      origin: "ace",
      fidelity: "full",
      native: { provider: "claude", nativeId: child },
      cwd: "/repo",
    });
    h.send({ type: "agent.external", agent: child, threadId: `thread-${child}`, status });
  }
  return h;
}

const queued: ThreadStatus = { state: "waiting", on: "queue" };

it("a child queued for its parent's run slot is not counted as working", () => {
  const h = parentWith({ running: { state: "working", agents: 1 }, waiting: queued });
  expect(deriveThreadStatus(h.state)).toEqual({ state: "working", agents: 1 });
  expect(h.state.agents["waiting"]?.agent.status).toMatchObject({ state: "blocked", on: "queue" });
});

it("a parent whose only open child is queued waits and is never done", () => {
  const h = parentWith({ finished: { state: "done" }, waiting: queued });
  expect(deriveThreadStatus(h.state).state).toBe("waiting");
});
