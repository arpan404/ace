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

test.each(["read-only", "ask", "auto-review", "full-access"] as const)(
  "a provider's own approval for an ace read stays pending for the person in %s",
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
      { permissionSettings: async () => ({ access: mode }) },
    );
    try {
      const id = await h.create();
      await h.engine.flush();
      const interaction = Object.values(h.store.snapshotThread(id).interactions)[0];
      if (!interaction) throw new Error("No provider approval");
      // The action still reads as ace's tool; nobody but the person answers it.
      expect(interaction).toMatchObject({
        state: "pending",
        request: {
          target: { tool: "ace_thread_read", origin: "ace", riskClass: "read-only" },
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
      expect(h.store.getInteraction(interaction.id)).toMatchObject({
        state: "resolved",
        resolution: { optionId: "once" },
      });
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

test.each(["full-access", "auto-review"] as const)(
  "in %s Codex's gate on a destructive ace tool waits for the person on that call's row",
  async (mode) => {
    const frames = scriptFrames();
    const h = await harness(
      [{ on: "send", frames: [frames.frame(start, ...codexGate("ace_thread_merge", merge))] }],
      frames,
      { permissionSettings: async () => ({ access: mode }) },
    );
    try {
      const id = await h.create();
      await h.engine.flush();
      const thread = h.store.snapshotThread(id);
      const interaction = Object.values(thread.interactions)[0];
      const call = Object.values(thread.items).find((item) => item.type === "tool_call");
      expect(interaction).toMatchObject({
        state: "pending",
        toolCallId: call?.id,
        request: { target: { tool: "ace_thread_merge", origin: "ace" } },
      });
    } finally {
      await h.close();
    }
  },
);

test("a request from another machine shown during an ace tool call reads on that call", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      {
        on: "send",
        frames: [
          frames.frame(
            start,
            ...codexGate("ace_browser_navigate", {
              url: "https://a.test",
              machine: "studio",
            }).slice(0, 1),
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
      "machine-request:studio:1",
      {
        kind: "approval",
        title: "studio: run a command",
        target: { tool: "ace_browser_navigate", access: "execute" },
        options: [{ id: "allow_once", label: "Allow once", kind: "allow_once" }],
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

test.each([
  { server: "foreign", input: { threadId: "child" } },
  { server: "ace", input: { threadId: "child", execute: "rm" } },
])(
  "foreign tools and invalid arguments never read as ace's own action: $server",
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
      const target = interaction?.request.kind === "approval" ? interaction.request.target : {};
      expect(target).not.toMatchObject({ origin: "ace" });
    } finally {
      await h.close();
    }
  },
);
