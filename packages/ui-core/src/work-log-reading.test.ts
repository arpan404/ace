import { Item, type ToolCall } from "@ace/protocol";
import { expect, test } from "vitest";
import { changedFileChips } from "./file-changes.ts";
import { groupSteps } from "./step-groups.ts";
import { shownStep, stepGlyphKind } from "./step-shown.ts";
import { describeStep } from "./work-log.ts";
import { readWorkLog } from "./work-log-reading.ts";

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
