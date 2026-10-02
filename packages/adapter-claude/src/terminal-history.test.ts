import { expect, test } from "vitest";
import { harness } from "./translator.test-helper.ts";

function registeredChild() {
  const h = harness();
  h.init();
  h.system("task_started", { task_id: "C", tool_use_id: "launch", task_type: "local_agent" });
  return h;
}

for (const status of ["succeeded", "failed"])
  test(`late permission preserves the child's persisted ${status} tool outcome`, () => {
    const h = registeredChild();
    const request = (requestId: string) =>
      h.send(
        {
          toolName: "Read",
          input: { file_path: "file" },
          options: { requestId, toolUseID: "read", agentID: "C" },
        },
        "can_use_tool",
      );
    const allow = (requestId: string) =>
      h.send({ requestId, result: { behavior: "allow" } }, "can_use_tool", "send");
    request("original");
    allow("original");
    h.send({
      type: "user",
      parent_tool_use_id: "launch",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "read",
            content: "file",
            is_error: status === "failed",
          },
        ],
      },
    });
    h.system("task_updated", { task_id: "C", patch: { status: "completed" } });
    h.result();
    const result = () =>
      h.items().find((item) => item.type === "tool_call" && item.call.kind === "file.read");
    expect(result()).toMatchObject({ complete: true, call: { status } });
    request("late");
    expect(result()).toMatchObject({ complete: true, call: { status } });
    allow("late");
    expect(result()).toMatchObject({ complete: true, call: { status } });
    expect(Object.values(h.state.interactions).map((item) => item.state)).toEqual([
      "resolved",
      "resolved",
    ]);
    expect(h.state.status.state).toBe("done");
  });

for (const kind of ["text", "thinking"])
  test(`a late streamed ${kind === "text" ? "paragraph" : "reasoning item"} stays complete after its child has settled`, () => {
    const h = registeredChild();
    h.system("task_updated", { task_id: "C", patch: { status: "completed" } });
    h.result();
    const stream = (event: unknown) =>
      h.send({ type: "stream_event", parent_tool_use_id: "launch", event });
    stream({ type: "message_start", message: { id: "late" } });
    stream({
      type: "content_block_start",
      index: 0,
      content_block: { type: kind, [kind]: "start" },
    });
    const item = () =>
      h.items().find((entry) => entry.type === (kind === "text" ? "message" : "reasoning"));
    expect(item()).toMatchObject({ complete: true });
    stream({
      type: "content_block_delta",
      index: 0,
      delta: { type: `${kind}_delta`, [kind]: " end" },
    });
    expect(item()).toMatchObject(
      kind === "text"
        ? { complete: true, parts: [{ type: "text", text: "start end" }] }
        : { complete: true, text: "start end" },
    );
    expect(Object.values(h.state.runs)).toHaveLength(2);
    expect(h.state.status.state).toBe("done");
  });
