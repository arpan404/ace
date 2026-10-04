import { expect, test } from "vitest";
import { harness } from "./translator.test-helper.ts";

type Harness = ReturnType<typeof harness>;
function register(h: Harness) {
  h.init();
  h.system("task_started", { task_id: "C", tool_use_id: "launch", task_type: "local_agent" });
}
function settle(h: Harness) {
  h.system("task_updated", { task_id: "C", patch: { status: "completed" } });
  h.result();
}
function request(h: Harness) {
  h.send(
    {
      toolName: "Read",
      input: { file_path: "file" },
      marker: "late-permission",
      options: { requestId: "late", toolUseID: "read", agentID: "C" },
    },
    "can_use_tool",
  );
}
function toolResult(h: Harness, status: string, marker: string) {
  h.send({
    type: "user",
    parent_tool_use_id: "launch",
    marker,
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "read",
          content: marker,
          is_error: status === "failed",
        },
      ],
    },
  });
}
function rawCount(h: Harness, marker: string) {
  return h
    .rawPayloads()
    .filter((payload) => "data" in payload && JSON.stringify(payload.data)?.includes(marker))
    .length;
}

for (const status of ["succeeded", "failed"])
  test(`result-first child history keeps its ${status} outcome and original raw after a late permission`, () => {
    const h = harness();
    register(h);
    toolResult(h, status, "original-result");
    const child = Object.values(h.state.agents).find(
      (record) => record.agent.native.nativeId === "C",
    );
    expect(h.items().find((item) => item.type === "tool_call")).toMatchObject({
      agentId: child?.agent.id,
      complete: true,
      call: { status },
    });
    settle(h);
    request(h);
    expect(h.items().find((item) => item.type === "tool_call")).toMatchObject({
      agentId: child?.agent.id,
      complete: true,
      call: { status, kind: "file.read" },
    });
    expect(rawCount(h, "original-result")).toBe(1);
    expect(rawCount(h, "late-permission")).toBe(1);
    expect(Object.values(h.state.interactions)).toEqual([]);
    expect(h.state.status.state).toBe("done");
  });

for (const status of ["completed", "failed", "killed", "stopped"])
  test(`a permission received after a ${status} child retires without waiting for a reply`, () => {
    const h = harness();
    register(h);
    h.system("task_updated", { task_id: "C", patch: { status } });
    h.result();
    const terminal = h.state.status;
    const boundary = h.events.length;
    request(h);
    expect(h.state.status).toEqual(terminal);
    expect(h.events.slice(boundary).some((event) => event.type === "interaction.opened")).toBe(
      false,
    );
    expect(Object.values(h.state.interactions)).toEqual([]);
    expect(h.items().find((item) => item.type === "tool_call")).toMatchObject({
      complete: true,
      call: { status: "cancelled" },
    });
    expect(
      h
        .items()
        .some(
          (item) =>
            item.type === "notice" && item.level === "info" && item.text.includes("settled"),
        ),
    ).toBe(true);
    expect(rawCount(h, "late-permission")).toBe(1);
    expect(Object.values(h.state.runs)).toHaveLength(2);
  });

for (const status of ["succeeded", "failed"])
  test(`a contradictory late result cannot replace a settled child's ${status} tool outcome`, () => {
    const h = harness();
    register(h);
    toolResult(h, status, "original-result");
    settle(h);
    toolResult(h, status === "succeeded" ? "failed" : "succeeded", "contradictory-result");
    expect(h.items().find((item) => item.type === "tool_call")).toMatchObject({
      complete: true,
      call: { status },
    });
    expect(rawCount(h, "original-result")).toBe(1);
    expect(rawCount(h, "contradictory-result")).toBe(1);
    expect(Object.values(h.state.runs)).toHaveLength(2);
    expect(h.state.status.state).toBe("done");
  });

test("a child tool's result without a parent hint keeps its output on the owning child", () => {
  const h = harness();
  register(h);
  h.send({
    type: "assistant",
    parent_tool_use_id: "launch",
    message: {
      id: "shell",
      content: [{ type: "tool_use", id: "read", name: "Bash", input: { command: "pwd" } }],
    },
  });
  h.send({
    type: "user",
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_result", tool_use_id: "read", content: "result output" }] },
  });
  const child = Object.values(h.state.agents).find(
    (record) => record.agent.native.nativeId === "C",
  );
  expect(h.items().find((item) => item.type === "tool_call")).toMatchObject({
    agentId: child?.agent.id,
    call: { status: "succeeded", detail: { kind: "shell", output: { tail: "result output" } } },
  });
});
