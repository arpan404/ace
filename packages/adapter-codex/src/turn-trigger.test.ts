import { ThreadId } from "@ace/protocol";
import { expect, test } from "vitest";
import { createCodexTranslator } from "./translator.ts";

/** A Codex session whose root thread "native" is idle after its first turn. */
function idleCodex() {
  const translator = createCodexTranslator({ threadId: ThreadId.parse("t"), rootKey: "root" });
  let seq = 0;
  const frame = (dir: "recv" | "note", data: unknown) =>
    translator.translate({ seq: seq++, t: seq, dir, channel: "stdio", data }, seq);
  const recv = (method: string, params: unknown) => frame("recv", { method, params });
  recv("thread/started", { thread: { id: "native", cwd: "/repo" } });
  recv("turn/started", { threadId: "native", turn: { id: "first" } });
  recv("turn/completed", { threadId: "native", turn: { id: "first", status: "completed" } });
  return {
    recv,
    note: (data: unknown) => frame("note", data),
    /** The trigger of the root turn Codex starts now. */
    started(turn: string) {
      const fact = recv("turn/started", { threadId: "native", turn: { id: turn } }).find(
        (candidate) => candidate.type === "turn.started" && candidate.agent === "root",
      );
      return fact?.type === "turn.started" ? fact.trigger : undefined;
    },
  };
}
const childFinished = {
  threadId: "native",
  item: {
    id: "child-done",
    type: "subAgentActivity",
    kind: "completed",
    agentThreadId: "child",
    agentPath: "reviewer",
  },
};

test("a turn Codex starts for ace's queued message is that message's, though a child's result came first", () => {
  const codex = idleCodex();
  codex.recv("thread/queue/changed", { threadId: "native" });
  codex.recv("item/completed", childFinished);
  expect(codex.started("second")).toBe("queue");
});

test("a turn a finished child starts by itself is the child's result", () => {
  const codex = idleCodex();
  codex.recv("item/completed", childFinished);
  expect(codex.started("second")).toBe("subagent_result");
});

test("once Codex's queue is empty again, a child's wake is never taken for ace's message", () => {
  const codex = idleCodex();
  codex.recv("thread/queue/changed", { threadId: "native" });
  codex.note({ event: "queue-state", count: 0 });
  codex.recv("item/completed", childFinished);
  expect(codex.started("second")).toBe("subagent_result");
});
