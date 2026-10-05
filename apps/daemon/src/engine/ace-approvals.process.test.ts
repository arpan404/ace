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

test.each(["auto-review", "read-only"] as const)(
  "delegation in %s receives its scoped execution risk and respects the read-only ceiling",
  async (mode) => {
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
        {
          on: "resolve",
          frames: [
            frames.frame(
              {
                type: "item.upsert",
                agent: "root",
                item: "call",
                draft: {
                  type: "tool_call",
                  complete: true,
                  call: { status: mode === "read-only" ? "declined" : "succeeded" },
                },
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
      expect(Object.values(h.store.snapshotThread(id).interactions)[0]).toMatchObject({
        state: "resolved",
        review: {
          decision: mode === "read-only" ? "deny" : "approve",
          target: { tool: "delegate_task", riskClass: "agent-execution", access: "execute" },
        },
        resolution: { optionId: mode === "read-only" ? "deny" : "once" },
      });
    } finally {
      await h.close();
    }
  },
);

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
      expect(Object.values(h.store.snapshotThread(id).interactions)[0]).toMatchObject({
        state: "pending",
        review: { decision: "escalate" },
      });
    } finally {
      await h.close();
    }
  },
);
