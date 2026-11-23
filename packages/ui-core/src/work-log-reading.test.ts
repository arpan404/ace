import { AgentStatus, Item, type ToolCall } from "@ace/protocol";
import { describe, expect, test } from "vitest";
import { changedFileChips } from "./file-changes.ts";
import { groupSteps } from "./step-groups.ts";
import { shownStep, stepGlyphKind } from "./step-shown.ts";
import { describeStep } from "./work-log.ts";
import { readWorkLog, thinksBetweenSteps } from "./work-log-reading.ts";

const call = (id: string, detail: ToolCall["detail"], status: ToolCall["status"]): Item =>
  Item.parse({
    id,
    agentId: "root",
    createdAt: 0,
    complete: status !== "running",
    type: "tool_call",
    call: {
      id,
      agentId: "root",
      kind: detail.kind,
      title: id,
      status,
      detail,
      startedAt: 0,
      raw: [],
    },
  });

test("a command left running counts as a background task, never folded into the commands before it", () => {
  const items = [
    call("build", { kind: "shell", command: "bun run build", exitCode: 0 }, "succeeded"),
    call("serve", { kind: "shell", command: "bun run dev" }, "succeeded"),
  ];
  const { facts } = readWorkLog(items, new Set(["serve"]));
  const groups = groupSteps(facts).groups;
  expect(groups.map((group) => [group.icon, group.ids])).toEqual([
    ["command", ["build"]],
    ["background", ["serve"]],
  ]);
});

test("a failed step run again with success no longer counts as failed", () => {
  const items = [
    call("first", { kind: "shell", command: "bun run test", exitCode: 1 }, "failed"),
    call("again", { kind: "shell", command: "bun run test", exitCode: 0 }, "succeeded"),
  ];
  const reading = readWorkLog(items, new Set());
  expect(reading.retried.has("first")).toBe(true);
  expect(groupSteps(reading.facts).groups[0]?.failed).toBe(0);
});

test("a command's exit code reads as Failed when it failed and as nothing when it finished", () => {
  const failed = call("f", { kind: "shell", command: "bun run lint", exitCode: 2 }, "failed");
  const passed = call("p", { kind: "shell", command: "bun run lint", exitCode: 0 }, "succeeded");
  expect(shownStep(failed, describeStep(failed)).step.note).toBe("Failed");
  expect(shownStep(passed, describeStep(passed)).step.note).toBeUndefined();
});

test("a step waiting on an approval shows no words of its own", () => {
  const waiting = call("w", { kind: "shell", command: "rm -rf dist" }, "awaiting_approval");
  const shown = shownStep(waiting, describeStep(waiting));
  expect(shown.awaiting).toBe(true);
  expect(shown.step.verb).toBe("");
  expect(shown.step.target).toBeUndefined();
});

test("changed files show four chips and fold the rest, never into a +1 more", () => {
  expect(changedFileChips(["a", "b", "c", "d", "e"])).toEqual({
    chips: ["a", "b", "c", "d", "e"],
    more: 0,
    label: "Changed 5 files",
  });
  expect(changedFileChips(["a", "b", "c", "d", "e", "f"])).toMatchObject({
    chips: ["a", "b", "c", "d"],
    more: 2,
  });
  expect(changedFileChips(["a"]).label).toBe("Changed 1 file");
});

test("a step's glyph says what it did: a listing command lists, a spawn reaches an agent", () => {
  expect(stepGlyphKind(call("ls", { kind: "shell", command: "ls src" }, "succeeded"))).toBe("list");
  expect(stepGlyphKind(call("t", { kind: "shell", command: "bun run test" }, "succeeded"))).toBe(
    "command",
  );
  expect(
    stepGlyphKind(
      call("s", { kind: "agent.spawn", prompt: "Audit" } as ToolCall["detail"], "succeeded"),
    ),
  ).toBe("agent");
});

const thinking = (id: string, text: string, complete: boolean): Item =>
  Item.parse({ id, agentId: "root", type: "reasoning", text, complete, createdAt: 0 });

test("a thought in flight with no words leaves the steps' rows as they were and is the log's live state", () => {
  const read = call("a", { kind: "file.read", path: "src/a.ts" }, "succeeded");
  const before = groupSteps(readWorkLog([read], new Set()).facts);
  const reading = readWorkLog([read, thinking("t", "", false)], new Set());
  expect(reading.thinking).toBe("t");
  const during = groupSteps(reading.facts, before);
  // The lone step stays a lone step: no group appears for the thought and vanishes after it.
  expect(during.groups).toBe(before.groups);

  const next = call("b", { kind: "shell", command: "bun test", exitCode: 0 }, "succeeded");
  const after = readWorkLog([read, thinking("t", "", true), next], new Set());
  expect(after.thinking).toBeUndefined();
  expect(groupSteps(after.facts, during).groups.map((group) => [group.key, group.ids])).toEqual([
    ["a", ["a", "b"]],
  ]);
});

test("a thought with words is its own row while it streams and joins the steps once done", () => {
  const read = call("a", { kind: "file.read", path: "src/a.ts" }, "succeeded");
  const reading = readWorkLog([read, thinking("t", "Check the caller", false)], new Set());
  expect(reading.thinking).toBeUndefined();
  const during = groupSteps(reading.facts);
  expect(during.groups.map((group) => group.ids)).toEqual([["a"], ["t"]]);
  const done = readWorkLog([read, thinking("t", "Check the caller", true)], new Set());
  expect(groupSteps(done.facts, during).groups.map((group) => group.ids)).toEqual([["a", "t"]]);
});

const words = (id: string, complete: boolean, type: "message" | "reasoning" = "message") =>
  Item.parse(
    type === "message"
      ? { id, agentId: "root", createdAt: 0, complete, type, role: "assistant", parts: [] }
      : { id, agentId: "root", createdAt: 0, complete, type, text: "" },
  );
const threadOf = (status: AgentStatus, order: readonly string[]) => ({
  thread: { rootAgentId: "root" },
  order,
  agent: (id: string) => (id === "root" ? { status } : undefined),
});
const between = (
  status: AgentStatus,
  items: readonly Item[],
  order: readonly string[] = items.map((item) => item.id),
) =>
  thinksBetweenSteps(
    threadOf(status, order),
    items.map((item) => item.id),
    readWorkLog(items, new Set()),
  );

describe("the live log thinks between steps", () => {
  const ran = call("ran", { kind: "shell", command: "rg steer", exitCode: 0 }, "succeeded");
  const running = call("running", { kind: "shell", command: "bun run typecheck" }, "running");
  const planning: AgentStatus = { state: "working", activity: "starting_turn" };

  test("once a call ends and nothing follows yet, the model is thinking", () => {
    // Antigravity sends no thought before its next call: only its state says it is working.
    expect(between(planning, [ran])).toBe(true);
  });

  test("a call in flight is the step shown, not thinking", () => {
    const status = AgentStatus.parse({ state: "working", activity: "tool", itemId: "running" });
    expect(between(status, [ran, running])).toBe(false);
  });

  test("a reply still arriving is the step shown, not thinking", () => {
    expect(between({ state: "working", activity: "responding" }, [ran, words("say", false)])).toBe(
      false,
    );
  });

  test("a thought with no words yet already stands as the thinking row", () => {
    expect(
      between({ state: "working", activity: "thinking" }, [ran, words("t", false, "reasoning")]),
    ).toBe(false);
  });

  test("only the log holding the thread's newest item thinks", () => {
    // An earlier log of the same turn, before a steer the person sent.
    expect(between(planning, [ran], ["ran", "steer"])).toBe(false);
  });

  test("a turn that is over, waits on the person or waits on its subagents is not thinking", () => {
    expect(between({ state: "idle" }, [ran])).toBe(false);
    expect(between({ state: "blocked", on: "human", refs: [] }, [ran])).toBe(false);
    // Its live line already says "Waiting on 2".
    expect(between({ state: "blocked", on: "subagents", refs: ["a", "b"] }, [ran])).toBe(false);
  });
});
