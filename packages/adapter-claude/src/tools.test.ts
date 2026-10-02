import { expect, test } from "vitest";
import { harness } from "./translator.test-helper.ts";

test("native file edits expose the changed path and text and keep wire input metadata", () => {
  const h = harness();
  h.init();
  const frame = {
    type: "assistant",
    message: {
      id: "m",
      content: [
        {
          type: "tool_use",
          id: "edit",
          name: "Edit",
          input: { file_path: "math.ts", old_string: "+", new_string: "-", unknown: "kept" },
        },
      ],
    },
    wire_tool_inputs: { edit: { untouched: true } },
  };
  h.send(frame);
  expect(h.items().find((item) => item.type === "tool_call")).toMatchObject({
    call: {
      kind: "file.edit",
      detail: { changes: [{ path: "math.ts", oldText: "+", newText: "-" }] },
      raw: [{ name: "Edit", data: frame }],
    },
  });
});
test("MCP calls expose the native server, tool and arguments", () => {
  const h = harness();
  h.init();
  h.tool("mcp", "mcp__docs__search", { query: "TypeScript" });
  expect(h.items().find((item) => item.type === "tool_call")).toMatchObject({
    call: {
      kind: "mcp",
      detail: { server: "docs", tool: "search", arguments: { query: "TypeScript" } },
    },
  });
});
test("file reads keep the requested path", () => {
  const h = harness();
  h.init();
  h.tool("read", "Read", { file_path: "README.md" });
  expect(h.items().find((item) => item.type === "tool_call")).toMatchObject({
    call: { kind: "file.read", detail: { path: "README.md" } },
  });
});
test("todo writes retain valid entries while preserving future entries in raw", () => {
  const h = harness();
  h.init();
  const todos = [{ content: "fix", status: "in_progress" }, { future: true }];
  h.tool("todos", "TodoWrite", { todos });
  expect(h.items().find((item) => item.type === "tool_call")).toMatchObject({
    call: {
      kind: "todo",
      detail: { todos: [{ content: "fix", status: "in_progress" }] },
      raw: [{ data: { message: { content: [{ input: { todos } }] } } }],
    },
  });
});
test("unknown fields on status and result frames are retained as raw data", () => {
  const h = harness();
  h.init();
  h.system("status", { status: "requesting", future: { level: 7 } });
  h.result({ future_result: "kept" });
  const data = h
    .items()
    .flatMap((item) =>
      item.type === "notice"
        ? item.raw.flatMap((payload) => ("data" in payload ? [payload.data] : []))
        : [],
    );
  expect(data).toContainEqual({
    type: "system",
    subtype: "status",
    status: "requesting",
    future: { level: 7 },
  });
  expect(data).toContainEqual(expect.objectContaining({ type: "result", future_result: "kept" }));
});
