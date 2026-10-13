import { expect, test } from "vitest";
import { harness, scriptFrames, start, end } from "./test-support.ts";
import type { Fact } from "@ace/core";

function approval(tool: string, input: unknown, server = "ace"): Fact[] {
  return [
    {
      type: "item.upsert",
      agent: "root",
      item: "call",
      draft: {
        type: "tool_call",
        complete: false,
        call: {
          title: tool,
          kind: "mcp",
          status: "awaiting_approval",
          detail: { kind: "mcp", server, tool, arguments: input },
        },
      },
    },
    {
      type: "interaction.opened",
      agent: "root",
      interaction: "approval",
      item: "call",
      blocking: true,
      request: {
        kind: "approval",
        title: "Unknown tool",
        options: [
          { id: "once", label: "Allow", kind: "allow_once" },
          { id: "deny", label: "Deny", kind: "deny" },
        ],
      },
    },
  ];
}

test.each(["auto-review", "ask", "read-only"] as const)(
  "ace transcript reads in %s resolve automatically with an exact action",
  async (mode) => {
    const frames = scriptFrames();
    const h = await harness(
      [
        {
          on: "send",
          frames: [
            frames.frame(start, ...approval("ace_thread_read", { threadId: "child", limit: 20 })),
          ],
        },
        {
          on: "resolve",
          frames: [
            frames.frame(
              {
                type: "item.upsert",
                agent: "root",
                item: "call",
                draft: { type: "tool_call", complete: true, call: { status: "succeeded" } },
              },
              end,
            ),
          ],
        },
      ],
      frames,
      { permissionSettings: async () => mode },
    );
    try {
      const id = await h.create();
      const interaction = Object.values(h.store.snapshotThread(id).interactions)[0];
      expect(interaction).toMatchObject({
        state: "resolved",
        request: {
          target: {
            tool: "ace_thread_read",
            origin: "ace",
            access: "read",
            riskClass: "read-only",
            input: { threadId: "child" },
          },
        },
        review: { decision: "approve" },
        resolution: { optionId: "once" },
      });
      expect(interaction?.request.kind === "approval" && interaction.request.title).toContain(
        "child",
      );
      expect(h.errors).toEqual([]);
    } finally {
      await h.close();
    }
  },
);

/** Codex's gate on a running ace tool call: an approval with no item, naming ace's server. */
function codexGate(tool: string, input: unknown): Fact[] {
  return [
    {
      type: "item.upsert",
      agent: "root",
      item: "call",
      draft: {
        type: "tool_call",
        complete: false,
        call: {
          title: tool,
          kind: "mcp",
          status: "running",
          detail: { kind: "mcp", server: "ace", tool, arguments: input },
        },
      },
    },
    {
      type: "interaction.opened",
      agent: "root",
      interaction: "gate",
      blocking: true,
      request: {
        kind: "approval",
        title: tool,
        target: { tool, access: "unknown", input },
        mcpServer: { name: "ace", source: "codex" },
        options: [
          { id: "accept", label: "Allow once", kind: "allow_once" },
          { id: "accept_session", label: "Allow for this thread", kind: "allow_session" },
          { id: "decline", label: "Deny", kind: "deny" },
        ],
      },
    },
  ];
}
const merge = { threadId: "child", requestId: "merge-1" };

test("in Full access ace answers Codex's gate on its own destructive tool without asking", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, ...codexGate("ace_thread_merge", merge))] },
      { on: "resolve", frames: [frames.frame(end)] },
    ],
    frames,
    { permissionSettings: async () => ":danger-full-access" },
  );
  try {
    const id = await h.create();
    const interaction = Object.values(h.store.snapshotThread(id).interactions)[0];
    expect(interaction).toMatchObject({
      state: "resolved",
      review: { decision: "approve", mode: "full-access" },
      resolution: { optionId: "accept" },
    });
  } finally {
    await h.close();
  }
});

test("outside Full access Codex's gate on a destructive ace tool asks the person on that call's row", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [{ on: "send", frames: [frames.frame(start, ...codexGate("ace_thread_merge", merge))] }],
    frames,
    { permissionSettings: async () => ":workspace" },
  );
  try {
    const id = await h.create();
    const thread = h.store.snapshotThread(id);
    const interaction = Object.values(thread.interactions)[0];
    const call = Object.values(thread.items).find((item) => item.type === "tool_call");
    expect(interaction).toMatchObject({
      state: "pending",
      toolCallId: call?.id,
      review: { decision: "escalate", target: { tool: "ace_thread_merge", origin: "ace" } },
    });
  } finally {
    await h.close();
  }
});

test("ace's own consent asked during an ace tool call reads on that call", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      {
        on: "send",
        frames: [
          frames.frame(
            start,
            ...codexGate("ace_browser_navigate", { url: "https://a.test" }).slice(0, 1),
          ),
        ],
      },
    ],
    frames,
  );
  try {
    const id = await h.create();
    const opened = h.engine.openHostApproval(
      id,
      "origin",
      {
        kind: "approval",
        title: "open https://a.test in the thread browser",
        target: { tool: "ace_browser_navigate", access: "execute" },
        options: [{ id: "allow_thread", label: "Allow for this thread", kind: "allow_session" }],
      },
      [],
    );
    const thread = h.store.snapshotThread(id);
    const call = Object.values(thread.items).find((item) => item.type === "tool_call");
    expect(h.store.getInteraction(opened)?.toolCallId).toBe(call?.id);
  } finally {
    await h.close();
  }
});

test("ace delegation asks the person outside Full access", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      {
        on: "send",
        frames: [
          frames.frame(
            start,
            ...approval("delegate_task", {
              requestId: "greeter",
              task: "Say hello",
              role: "greeter",
              provider: "claude",
            }),
          ),
        ],
      },
      { on: "resolve", frames: [frames.frame(end)] },
    ],
    frames,
    { permissionSettings: async () => ":workspace" },
  );
  try {
    const id = await h.create();
    const interaction = Object.values(h.store.snapshotThread(id).interactions)[0];
    if (!interaction) throw new Error("No consent request");
    expect(interaction).toMatchObject({
      state: "pending",
      review: {
        decision: "escalate",
        target: { tool: "delegate_task", riskClass: "agent-execution", access: "execute" },
      },
    });
    expect(
      h.command({
        type: "interaction.resolve",
        interactionId: interaction.id,
        resolution: { kind: "approval", optionId: "once" },
      }).ok,
    ).toBe(true);
    await h.engine.flush();
    expect(h.store.getInteraction(interaction.id)?.state).toBe("resolved");
  } finally {
    await h.close();
  }
});

test.each([
  { server: "foreign", input: { threadId: "child" } },
  { server: "ace", input: { threadId: "child", execute: "rm" } },
])(
  "foreign tools and invalid arguments cannot borrow ace read-only authority: $server",
  async ({ server, input }) => {
    const frames = scriptFrames();
    const h = await harness(
      [
        {
          on: "send",
          frames: [frames.frame(start, ...approval("ace_thread_read", input, server))],
        },
      ],
      frames,
    );
    try {
      const id = await h.create();
      const interaction = Object.values(h.store.snapshotThread(id).interactions)[0];
      expect(interaction?.state).toBe("pending");
      expect(interaction?.review).toBeUndefined();
    } finally {
      await h.close();
    }
  },
);
