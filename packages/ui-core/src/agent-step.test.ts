import { Item, type AgentStatus, type ToolCall } from "@ace/protocol";
import { expect, test } from "vitest";
import { agentResult, agentStep, agentTask } from "./agent-step.ts";

const call = (patch: Partial<ToolCall> & Pick<ToolCall, "detail">): Item =>
  Item.parse({
    type: "tool_call",
    id: "call",
    agentId: "agent",
    createdAt: 1,
    complete: false,
    call: {
      id: "call",
      agentId: "agent",
      kind: patch.detail.kind === "browser" ? "browser" : (patch.detail.kind as ToolCall["kind"]),
      title: "",
      status: "running",
      startedAt: 1,
      raw: [],
      ...patch,
    },
  });
const working = { state: "working", activity: "tool" } as const satisfies AgentStatus;

test.each([
  [
    call({ detail: { kind: "shell", command: "/bin/zsh -lc 'bun run typecheck'" } }),
    "running bun run typecheck",
  ],
  [
    call({ detail: { kind: "file.read", path: "/repo/apps/web/turn-index.ts" } }),
    "reading turn-index.ts",
  ],
  [
    call({
      detail: { kind: "file.edit", changes: [{ path: "src/work-side.tsx", kind: "update" }] },
    }),
    "editing work-side.tsx",
  ],
  [
    call({
      detail: {
        kind: "file.edit",
        changes: [
          { path: "a.ts", kind: "update" },
          { path: "b.ts", kind: "update" },
          { path: "c.ts", kind: "update" },
        ],
      },
    }),
    "editing a.ts and 2 more",
  ],
  [call({ detail: { kind: "search", query: "useTurnHead" } }), "searching for useTurnHead"],
  [
    call({ status: "awaiting_approval", detail: { kind: "shell", command: "rm -rf dist" } }),
    "waiting on approval",
  ],
])("a running tool reads as its step in plain words", (item, step) => {
  expect(agentStep({ status: working, item })).toBe(step);
});

test("an agent writing or thinking says so rather than a bare activity word", () => {
  expect(agentStep({ status: { state: "working", activity: "responding" } })).toBe(
    "writing its reply",
  );
  expect(agentStep({ status: { state: "working", activity: "thinking" } })).toBe("thinking");
});

test("an agent waiting on the person names what it waits for", () => {
  const status: AgentStatus = { state: "blocked", on: "human", refs: ["q"] };
  expect(agentStep({ status, interaction: { request: { kind: "question", questions: [] } } })).toBe(
    "waiting on your answer",
  );
  expect(
    agentStep({
      status,
      interaction: { request: { kind: "approval", title: "Run", options: [] } },
    }),
  ).toBe("waiting on approval");
});

test("a failed agent's step is the first line of its error", () => {
  expect(
    agentStep({
      status: {
        state: "failed",
        error: { kind: "provider", message: "Rate limit reached.\nTry again later." },
      },
    }),
  ).toBe("Rate limit reached.");
});

const spawn = call({
  status: "succeeded",
  title: "Task",
  detail: {
    kind: "agent.spawn",
    prompt: "Find every caller of useTurnHead\nand list them with their files.",
  },
  result: {
    isError: false,
    durationMs: 10,
    content: [{ type: "text", text: "## Found 4 callers\n\n- timeline.tsx" }],
  },
});
test("a subagent's task is the first line of its prompt when its call has no description", () => {
  expect(agentTask(spawn)).toBe("Find every caller of useTurnHead");
});

test("a finished subagent's result is the first line of what it handed back", () => {
  expect(agentResult(spawn)).toBe("Found 4 callers");
});
