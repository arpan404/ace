import { expect, test } from "vitest";
import { setup } from "./translator.test-helper.ts";

type H = ReturnType<typeof setup>;
const children = (h: H) =>
  Object.values(h.state.agents)
    .map((record) => record.agent)
    .filter((agent) => agent.origin === "provider_subagent")
    .map(({ name, role }) => ({ name, role }));

const spawnAgent = {
  id: "spawn",
  type: "collabAgentToolCall",
  tool: "spawnAgent",
  status: "inProgress",
  senderThreadId: "native",
  receiverThreadIds: ["child"],
  prompt: "Audit the migration shards",
  model: null,
  reasoningEffort: null,
  agentsStates: {},
};

test("a Codex spawn_agent child is left unnamed, not blank, until Codex names it", () => {
  const h = setup();
  h.start();
  h.item(spawnAgent);
  expect(children(h)).toEqual([{ name: undefined, role: undefined }]);
  const call = h.state.items[Object.keys(h.state.items).find((key) => key.includes("spawn")) ?? ""];
  expect(call?.type === "tool_call" && call.call.detail).toMatchObject({
    kind: "agent.spawn",
    prompt: "Audit the migration shards",
  });
  h.recv("thread/started", {
    thread: {
      id: "child",
      parentThreadId: "native",
      cwd: "/repo",
      agentNickname: "Euclid",
      agentRole: "explorer",
    },
  });
  expect(children(h)).toEqual([{ name: "Euclid", role: "explorer" }]);
});

test("a Codex child named by its agent path keeps that name when its thread starts unnamed", () => {
  const h = setup();
  h.start();
  h.item({
    id: "call",
    type: "subAgentActivity",
    kind: "started",
    agentThreadId: "child",
    agentPath: "/root/count_src_lines",
  });
  expect(children(h)).toEqual([{ name: "count_src_lines", role: undefined }]);
  h.recv("thread/started", {
    thread: { id: "child", parentThreadId: "native", cwd: "/repo", agentNickname: null },
  });
  expect(children(h)).toEqual([{ name: "count_src_lines", role: undefined }]);
});
