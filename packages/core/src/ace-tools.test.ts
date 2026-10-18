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
  ["ace_screen_input", "screen_input"],
  ["ace_context", "context"],
  ["ace_ace_browser_open", "browser_open"],
  ["ace_browser_open", "browser_open"],
  ["ace_sim_act", "sim_act"],
  ["mcp__ace__thread_control", "thread_control"],
  ["screen_input", "screen_input"],
  ["browser_snapshot", "browser_snapshot"],
  ["sim_screenshot", "sim_screenshot"],
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
it.each(["context", "browser_click", "browser_navigate"])(
  "a bare custom call named %s that is not one of ace's own bare names stays the provider's own",
  (name) => {
    const feed = fixture();
    const events = feed({
      type: "item.upsert",
      agent: "root",
      item: "call",
      draft: {
        type: "tool_call",
        call: {
          kind: "custom",
          title: name,
          detail: { kind: "custom" },
          raw: [{ type: "provider.call", data: { name, input: { topic: "x" } } }],
        },
      },
    });
    expect(events.find((entry) => entry.type === "item.created")).toMatchObject({
      item: { call: { kind: "custom", detail: { kind: "custom" } } },
    });
  },
);
it("an ace MCP call reported under its old ace_ prefix reads as the bare tool", () => {
  const feed = fixture();
  const events = feed({
    type: "item.upsert",
    agent: "root",
    item: "call",
    draft: {
      type: "tool_call",
      call: {
        kind: "mcp",
        title: "ace_browser_snapshot",
        detail: { kind: "mcp", server: "ace", tool: "ace_browser_snapshot", arguments: {} },
      },
    },
  });
  expect(events.find((entry) => entry.type === "item.created")).toMatchObject({
    item: { call: { detail: { server: "ace", tool: "browser_snapshot" } } },
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
        title: "ace_screen_input",
        detail: { kind: "custom" },
        raw: [
          { type: "provider.call", data: { name: "ace_screen_input", input: { x: 12, y: 16 } } },
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
        title: "ace_screen_input",
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
        title: "screen_input",
        detail: { kind: "mcp", server: "other", tool: "screen_input" },
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
        title: "screen_measure",
        detail: {
          kind: "mcp",
          server: "ace",
          tool: "screen_measure",
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

it("text a computer-use batch types or sets stays private while its clicks and menus stay visible", () => {
  const feed = fixture();
  const events = feed({
    type: "item.upsert",
    agent: "root",
    item: "batch",
    draft: {
      type: "tool_call",
      call: {
        kind: "mcp",
        title: "screen_act",
        detail: {
          kind: "mcp",
          server: "ace",
          tool: "screen_act",
          arguments: {
            app: "TextEdit",
            actions: [
              { type: "menu", path: ["File", "New"] },
              { type: "type", text: "secret-typed" },
              { type: "set_value", id: 4, value: "secret-set" },
            ],
          },
        },
        raw: [{ type: "provider.call", data: { text: "secret-typed" } }],
      },
    },
  });
  expect(JSON.stringify(events)).not.toMatch(/secret-typed|secret-set/);
  expect(events.find((event) => event.type === "item.created")).toMatchObject({
    item: {
      call: {
        detail: {
          arguments: {
            app: "TextEdit",
            actions: [
              { type: "menu", path: ["File", "New"] },
              { type: "type", text: "[redacted]" },
              { type: "set_value", id: 4, value: "[redacted]" },
            ],
          },
        },
      },
    },
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
        target: { tool: "screen_input", input: { action: "type", text }, access: "write" },
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

it("a tools_call reads as the tool it ran, and the text that tool types stays private", () => {
  const feed = fixture();
  const events = feed({
    type: "item.upsert",
    agent: "root",
    item: "dispatch",
    draft: {
      type: "tool_call",
      call: {
        kind: "mcp",
        title: "tools_call",
        detail: {
          kind: "mcp",
          server: "ace",
          tool: "tools_call",
          arguments: {
            name: "browser_act",
            arguments: { action: "type", ref: "e1", text: "pw-1" },
          },
        },
        raw: [{ type: "provider.call", data: { text: "pw-1" } }],
      },
    },
  });
  expect(JSON.stringify(events)).not.toContain("pw-1");
  expect(events.find((event) => event.type === "item.created")).toMatchObject({
    item: {
      call: {
        detail: {
          tool: "browser_act",
          arguments: { action: "type", ref: "e1", text: "[redacted]" },
        },
      },
    },
  });
});

it("an approval of a tools_call that types text hides that text", () => {
  const feed = fixture();
  const events = feed({
    type: "interaction.opened",
    agent: "root",
    interaction: "dispatch",
    blocking: true,
    request: {
      kind: "approval",
      title: "Run tools_call",
      target: {
        tool: "mcp__ace__tools_call",
        input: { name: "screen_input", arguments: { action: "type", text: "pw-2" } },
        access: "write",
      },
      options: [{ id: "allow", label: "Allow", kind: "allow_once" }],
    },
    raw: [],
  });
  expect(JSON.stringify(events)).not.toContain("pw-2");
});

it("a Claude-spelled html_render approval hides the page markup", () => {
  const feed = fixture();
  const events = feed({
    type: "interaction.opened",
    agent: "root",
    interaction: "render",
    blocking: true,
    request: {
      kind: "approval",
      title: "Render",
      target: { tool: "mcp__ace__html_render", input: { html: "<p>private</p>" }, access: "write" },
      options: [{ id: "allow", label: "Allow", kind: "allow_once" }],
    },
    raw: [],
  });
  expect(JSON.stringify(events)).not.toContain("<p>private</p>");
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
        title: "ace_screen_input",
        detail: { kind: "custom" },
        raw: [
          {
            type: "session.tool.called",
            data: { type: "session.tool.called", data: { name: "ace_screen_input", input: {} } },
          },
          {
            type: "session.tool.input.ended",
            data: {
              type: "session.tool.input.ended",
              data: { name: "ace_screen_input", text: '{"x":12,"y":16}' },
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
        title: "ace_screen_input",
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
