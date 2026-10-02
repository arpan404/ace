import { expect, it } from "vitest";
import { harness } from "./replay.ts";
const cases = [
  ["bash", { command: "pwd" }, {}, "shell", { command: "pwd" }],
  [
    "read",
    { filePath: "x.ts", offset: 2, limit: 5 },
    {},
    "file.read",
    { path: "x.ts", range: { start: 2, end: 7 } },
  ],
  [
    "edit",
    { filePath: "x.ts", oldString: "old", newString: "new" },
    { diff: "-old\n+new" },
    "file.edit",
    { changes: [{ path: "x.ts", diff: "-old\n+new", oldText: "old", newText: "new" }] },
  ],
  [
    "write",
    { filePath: "new.ts", content: "new" },
    {},
    "file.write",
    { changes: [{ path: "new.ts", kind: "add", newText: "new" }] },
  ],
  [
    "apply_patch",
    { patchText: "*** Delete File: old.ts" },
    { files: [{ filePath: "old.ts", type: "delete" }] },
    "file.delete",
    { changes: [{ path: "old.ts", kind: "delete" }] },
  ],
  ["glob", { pattern: "*.ts", path: "src" }, {}, "search", { query: "*.ts", path: "src" }],
  ["websearch", { query: "Node" }, {}, "web.search", { query: "Node" }],
  ["webfetch", { url: "https://example.com" }, {}, "web.fetch", { url: "https://example.com" }],
  [
    "task",
    { task_id: "ses_existing", prompt: "follow up" },
    {},
    "agent.message",
    { message: "follow up" },
  ],
  [
    "docs_server_lookup",
    { query: "doc" },
    {},
    "mcp",
    { server: "docs_server", tool: "lookup", arguments: { query: "doc" } },
  ],
  ["plugin_new_tool", { untouched: "input" }, {}, "custom", {}],
] as const;
for (const [tool, input, metadata, kind, detail] of cases) {
  it(`renders ${tool} with typed details and retains its native input`, () => {
    const h = harness();
    h.feed({
      seq: 0,
      t: 0,
      dir: "recv",
      channel: "http",
      data: { method: "POST", path: "/session", body: { id: "ses_root" } },
    });
    h.feed({
      seq: 1,
      t: 1,
      dir: "recv",
      channel: "http",
      data: { path: "/mcp", body: { docs_server: { status: "connected" } } },
    });
    h.feed({
      seq: 2,
      t: 2,
      dir: "recv",
      channel: "sse",
      data: {
        payload: {
          type: "message.part.updated",
          properties: {
            part: {
              sessionID: "ses_root",
              id: "part",
              type: "tool",
              tool,
              callID: "call",
              state: { status: "completed", input, metadata },
            },
          },
        },
      },
    });
    const item = Object.values(h.view.items).find((i) => i.type === "tool_call");
    expect(item).toMatchObject({
      call: {
        kind,
        detail,
        status: "succeeded",
        raw: expect.arrayContaining([
          expect.objectContaining({
            name: tool,
            data: expect.objectContaining({ state: expect.objectContaining({ input }) }),
          }),
        ]),
      },
    });
  });
}
