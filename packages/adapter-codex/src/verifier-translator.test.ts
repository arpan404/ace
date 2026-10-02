import { expect, test } from "vitest";
import { setup, shell } from "./translator.test-helper.ts";
const output = (h: ReturnType<typeof setup>) => {
  const i = h.state.items["exec"];
  if (i?.type !== "tool_call" || i.call.detail.kind !== "shell") throw new Error("Shell missing");
  return i;
};
test("late output preserves completion after more than a thousand newer completions", () => {
  const h = setup();
  h.start();
  h.item({ ...shell, status: "completed", aggregatedOutput: "final" }, true);
  for (let i = 0; i < 1025; i++) h.item({ id: `new-${i}`, type: "agentMessage", text: "" }, true);
  h.end();
  h.recv("item/commandExecution/outputDelta", {
    threadId: "native",
    turnId: "turn",
    itemId: "exec",
    delta: "late",
  });
  expect(output(h).complete).toBe(true);
  expect(output(h).call.status).toBe("succeeded");
  expect(output(h).call.detail).toMatchObject({ output: "finallate" });
  expect(h.state.status.state).toBe("done");
});
test("repeated completion aggregates append no duplicate output and preserve later chunks", () => {
  const h = setup();
  h.start();
  const completed = { ...shell, status: "completed", aggregatedOutput: "final" };
  h.item(completed, true);
  h.end();
  h.item(completed, true);
  expect(output(h).call.detail).toMatchObject({ output: "final" });
  h.recv("item/commandExecution/outputDelta", {
    threadId: "native",
    itemId: "exec",
    delta: "late",
  });
  h.item(completed, true);
  expect(output(h).call.detail).toMatchObject({ output: "finallate" });
});
test("completion keeps the exact initial shell raw payload in the current item", () => {
  const h = setup();
  h.start();
  const initial = { ...shell, aggregatedOutput: "prefix", vendor: "original" };
  h.item(initial);
  h.item({ ...shell, status: "completed", aggregatedOutput: "prefixfinal" }, true);
  expect(output(h).call.raw.some((r) => JSON.stringify(r.data) === JSON.stringify(initial))).toBe(
    true,
  );
});
test("unknown thread noise stays raw until ancestry is confirmed and holds completion", () => {
  const h = setup();
  h.start();
  for (let i = 0; i < 300; i++)
    h.recv("item/agentMessage/delta", { threadId: `unknown-${i}`, itemId: "m", delta: `${i}` });
  h.end();
  expect(h.state.status.state).not.toBe("done");
  expect(Object.values(h.state.agents)).toHaveLength(1);
  const rawIds = new Set(
    Object.values(h.state.items).flatMap((i) =>
      i.type === "notice"
        ? i.raw.flatMap((r) => {
            const value = r.data;
            if (typeof value !== "object" || value === null || !("params" in value)) return [];
            const params = value.params;
            return typeof params === "object" && params !== null && "threadId" in params
              ? [params.threadId]
              : [];
          })
        : [],
    ),
  );
  for (let i = 0; i < 300; i++) expect(rawIds.has(`unknown-${i}`)).toBe(true);
  h.feed({
    seq: 998,
    t: 999,
    dir: "note",
    channel: "stdio",
    data: {
      event: "thread-discovered",
      thread: {
        id: "unknown-299",
        parentThreadId: "native",
        status: { type: "idle" },
        turns: [
          {
            id: "recovered",
            status: "completed",
            items: [{ id: "message", type: "agentMessage", text: "recovered" }],
          },
        ],
      },
    },
  });
  expect(h.state.status.state).not.toBe("done");

  h.feed({
    seq: 999,
    t: 1000,
    dir: "note",
    channel: "stdio",
    data: { event: "discovery-finished", task: "discovery:scan" },
  });
  expect(h.state.status.state).toBe("done");
});
test("background children keep the thread waiting while the child keeps working", () => {
  const h = setup();
  h.start();
  h.item({ id: "spawn", type: "subAgentActivity", kind: "started", agentThreadId: "child" }, true);
  h.start("child", "child-turn");
  h.end();
  expect(h.state.status).toEqual({ state: "waiting", on: "background_task" });
  expect(h.state.agents["child"]?.agent.status.state).toBe("working");
  h.end("completed", "child", "child-turn");
  expect(h.state.status.state).toBe("done");
});
test("a successfully announced child stays starting until its first turn or grace expires", () => {
  const h = setup();
  h.start();
  h.item({ id: "spawn", type: "subAgentActivity", kind: "started", agentThreadId: "child" }, true);
  expect(h.state.agents["child"]?.agent.status.state).toBe("starting");
});

test("an output-only command first seen after turn completion remains a stoppable background task", () => {
  const h = setup();
  h.start();
  h.end();
  h.recv("item/commandExecution/outputDelta", {
    threadId: "native",
    turnId: "turn",
    itemId: "exec",
    delta: "late",
  });
  expect(h.state.status).toEqual({ state: "waiting", on: "background_task" });
  expect(Object.values(h.state.tasks).some((t) => t.stoppable && t.status === "running")).toBe(
    true,
  );
  h.item({ ...shell, status: "completed", aggregatedOutput: "late" }, true);
  expect(h.state.status.state).toBe("done");
  expect(output(h).call.detail).toMatchObject({ output: "late" });
});
test("a native wait keeps the parent blocked on its live children without changing tool kind", () => {
  const h = setup();
  h.start();
  h.item({ id: "spawn", type: "subAgentActivity", kind: "started", agentThreadId: "child" }, true);
  h.start("child", "child-turn");
  const wait = {
    id: "wait",
    type: "collabAgentToolCall",
    tool: "wait",
    receiverThreadIds: [],
    status: "inProgress",
  };
  h.item(wait);
  expect(h.state.agents["root"]?.agent.status).toEqual({
    state: "blocked",
    on: "subagents",
    refs: [h.state.agents["child"]?.agent.id],
  });
  const item = h.state.items["wait"];
  expect(item?.type === "tool_call" && item.call.kind).toBe("agent.message");
  expect(
    item?.type === "tool_call" &&
      item.call.raw.some((r) => JSON.stringify(r.data) === JSON.stringify(wait)),
  ).toBe(true);
  h.item({ ...wait, status: "completed" }, true);
  expect(h.state.agents["root"]?.agent.status.state).toBe("working");
});
test("a replayed native start cannot reopen a completed shell during a newer turn", () => {
  const h = setup();
  h.start();
  h.item({ ...shell, status: "completed", aggregatedOutput: "final" }, true);
  h.end();
  h.start("native", "next");
  h.item(shell, false, "native", "turn");
  expect(output(h).complete).toBe(true);
  expect(output(h).call.status).toBe("succeeded");
  expect(output(h).call.detail).toMatchObject({ output: "final" });
});
