import { expect, it } from "vitest";
import { ThreadId, type EventPayload } from "@ace/protocol";
import { apply, createThreadState, type Fact } from "./index.ts";
function fixture() {
  let ordinal = 0;
  const state = createThreadState({
    threadId: ThreadId.parse("ace-tools"),
    config: { provider: "opencode", silenceMs: 90000 },
  });
  const feed = (fact: Fact): EventPayload[] =>
    apply(state, fact, { now: ++ordinal, ids: { next: (kind) => `${kind}-${ordinal}` } });
  feed({
    type: "agent.seen",
    agent: "root",
    origin: "root",
    fidelity: "full",
    native: { provider: "opencode" },
    cwd: "/fixture",
  });
  return feed;
}
it.each([
  ["ace_screen_click", "screen_click"],
  ["ace_ace_browser_open", "ace_browser_open"],
  ["screen_click", "screen_click"],
  ["device_screenshot", "device_screenshot"],
])("custom %s calls render as canonical ace MCP calls", (native, canonical) => {
  const feed = fixture();
  const events = feed({
    type: "item.upsert",
    agent: "root",
    item: "call",
    draft: {
      type: "tool_call",
      call: {
        kind: "custom",
        title: native,
        detail: { kind: "custom" },
        raw: [{ type: "provider.call", data: { name: native, input: { x: 12, y: 16 } } }],
      },
    },
  });
  const event = events.find((entry) => entry.type === "item.created");
  expect(event).toMatchObject({
    item: {
      call: {
        kind: "mcp",
        detail: { kind: "mcp", server: "ace", tool: canonical, arguments: { x: 12, y: 16 } },
      },
    },
  });
});
it("later custom completion frames preserve the original arguments and another MCP server keeps its identity", () => {
  const feed = fixture();
  feed({
    type: "item.upsert",
    agent: "root",
    item: "call",
    draft: {
      type: "tool_call",
      call: {
        kind: "custom",
        title: "ace_screen_click",
        detail: { kind: "custom" },
        raw: [
          { type: "provider.call", data: { name: "ace_screen_click", input: { x: 12, y: 16 } } },
        ],
      },
    },
  });
  const updated = feed({
    type: "item.upsert",
    agent: "root",
    item: "call",
    draft: {
      type: "tool_call",
      complete: true,
      call: {
        kind: "custom",
        title: "ace_screen_click",
        detail: { kind: "custom" },
        status: "succeeded",
        raw: [{ type: "provider.result", data: { output: "Done" } }],
      },
    },
  });
  expect(updated.find((event) => event.type === "item.updated")).toMatchObject({
    item: { call: { detail: { arguments: { x: 12, y: 16 } } } },
  });
  const foreign = feed({
    type: "item.upsert",
    agent: "root",
    item: "foreign",
    draft: {
      type: "tool_call",
      call: {
        kind: "mcp",
        title: "screen_click",
        detail: { kind: "mcp", server: "other", tool: "screen_click" },
      },
    },
  });
  expect(foreign.find((event) => event.type === "item.created")).toMatchObject({
    item: { call: { detail: { server: "other" } } },
  });
});
it("measurement input text is redacted before native evidence can be stored", () => {
  const feed = fixture();
  const events = feed({
    type: "item.upsert",
    agent: "root",
    item: "call",
    draft: {
      type: "tool_call",
      call: {
        kind: "mcp",
        title: "screen_measure_interaction",
        detail: {
          kind: "mcp",
          server: "ace",
          tool: "screen_measure_interaction",
          arguments: { action: { kind: "text.type", text: "secret" } },
        },
        raw: [{ type: "provider.call", data: { text: "secret" } }],
      },
    },
  });
  expect(JSON.stringify(events)).not.toContain("secret");
  expect(events.find((event) => event.type === "item.created")).toMatchObject({
    item: { call: { detail: { arguments: { action: { text: "[redacted]" } } } } },
  });
});

it("approval previews redact ace input without redacting another server's request", () => {
  const feed = fixture();
  for (const [server, text] of [
    ["ace", "private-ace-text"],
    ["other", "visible-other-text"],
  ]) {
    const events = feed({
      type: "interaction.opened",
      agent: "root",
      interaction: server ?? "unknown",
      blocking: true,
      request: {
        kind: "approval",
        title: `Type ${text}`,
        description: `Type ${text}`,
        target: { tool: "screen_type", input: { text }, access: "write" },
        mcpServer: { name: server ?? "", source: "test" },
        options: [{ id: "allow", label: "Allow", kind: "allow_once" }],
      },
      raw: [{ type: "provider.permission", data: { text } }],
    });
    if (server === "ace") {
      expect(JSON.stringify(events)).not.toContain("private-ace-text");
      expect(events.find((event) => event.type === "interaction.opened")).toMatchObject({
        interaction: { request: { target: { input: { text: "[redacted]" } } } },
      });
    } else expect(JSON.stringify(events)).toContain("visible-other-text");
  }
});

it("custom input streams use completed argument JSON without treating result text as arguments", () => {
  const feed = fixture();
  const events = feed({
    type: "item.upsert",
    agent: "root",
    item: "stream",
    draft: {
      type: "tool_call",
      call: {
        kind: "custom",
        title: "ace_screen_click",
        detail: { kind: "custom" },
        raw: [
          {
            type: "session.tool.called",
            data: { type: "session.tool.called", data: { name: "ace_screen_click", input: {} } },
          },
          {
            type: "session.tool.input.ended",
            data: {
              type: "session.tool.input.ended",
              data: { name: "ace_screen_click", text: '{"x":12,"y":16}' },
            },
          },
        ],
      },
    },
  });
  expect(events.find((event) => event.type === "item.created")).toMatchObject({
    item: { call: { detail: { arguments: { x: 12, y: 16 } } } },
  });
  const result = feed({
    type: "item.upsert",
    agent: "root",
    item: "stream",
    draft: {
      type: "tool_call",
      complete: true,
      call: {
        kind: "custom",
        title: "ace_screen_click",
        detail: { kind: "custom" },
        raw: [
          {
            type: "session.tool.success",
            data: { type: "session.tool.success", data: { text: '{"x":99}' } },
          },
        ],
      },
    },
  });
  expect(result.find((event) => event.type === "item.updated")).toMatchObject({
    item: { call: { detail: { arguments: { x: 12, y: 16 } } } },
  });
});
