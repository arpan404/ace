import { expect, test } from "vitest";
import { Engine } from "@ace/daemon";
import { applyEvent, createThreadView } from "@ace/projection";
import type { Fact } from "@ace/core";
import { harness, scriptFrames, start } from "./test-support.ts";

test.each(["shell", "file.write", "mcp"] as const)(
  "granting a %s execution permission leaves the tool running until result or process loss",
  async (kind) => {
    const frames = scriptFrames();
    const tool: Fact = {
      type: "item.upsert",
      agent: "root",
      item: "execute",
      draft: {
        type: "tool_call",
        complete: false,
        call: {
          kind,
          title: "Execute",
          status: "awaiting_approval",
          detail:
            kind === "shell"
              ? { kind, command: "offline" }
              : kind === "file.write"
                ? { kind, changes: [] }
                : { kind, server: "offline", tool: "run" },
        },
      },
    };
    const approval: Fact = {
      type: "interaction.opened",
      agent: "root",
      interaction: "permission",
      item: "execute",
      blocking: true,
      request: {
        kind: "approval",
        title: "Execute?",
        options: [{ id: "allow", label: "Allow", kind: "allow_once" }],
      },
    };
    const h = await harness(
      [
        { on: "send", frames: [frames.frame(start, tool, approval)] },
        {
          on: "resolve",
          frames: [
            frames.frame(
              {
                ...tool,
                draft: { type: "tool_call", complete: false, call: { status: "running" } },
              },
              { type: "interaction.closed", interaction: "permission", state: "resolved" },
            ),
          ],
        },
      ],
      frames,
      { permissionSettings: async () => ({ access: "ask" as const }), provider: "claude" },
    );
    let reopened: Engine | undefined;
    try {
      const id = await h.create();
      expect(
        Object.values(h.store.snapshotThread(id).items).find((i) => i.type === "tool_call"),
      ).toMatchObject({ call: { kind, status: "awaiting_approval" } });
      const request = Object.values(h.store.snapshotThread(id).interactions)[0];
      if (!request) throw new Error("Missing permission");
      h.command({
        type: "interaction.resolve",
        interactionId: request.id,
        resolution: { kind: "approval", optionId: "allow" },
      });
      await h.engine.flush();
      const snapshot = h.store.snapshotThread(id);
      expect(snapshot.interactions[request.id]?.state).toBe("resolved");
      expect(Object.values(snapshot.items).find((i) => i.type === "tool_call")).toMatchObject({
        complete: false,
        call: { status: "running" },
      });
      h.contexts[0]?.onExit({ deliberate: false, message: "crashed before execution result" });
      await h.engine.flush();
      const crashed = h.store.snapshotThread(id);
      expect(Object.values(crashed.items).find((i) => i.type === "tool_call")).toMatchObject({
        complete: true,
        call: { status: "cancelled" },
      });
      const replay = createThreadView(crashed.thread);
      for (const event of h.store.readEvents({ afterSeq: 0, threadId: id, limit: 1000 })) {
        replay.seq = event.seq - 1;
        applyEvent(replay, event);
      }
      expect(Object.values(replay.items).find((i) => i.type === "tool_call")).toMatchObject({
        call: { status: "cancelled" },
      });
      await h.engine.close();
      reopened = new Engine(h.store, { registry: h.registry, clock: h.clock });
      await reopened.flush();
      expect(
        Object.values(h.store.snapshotThread(id).items).find((i) => i.type === "tool_call"),
      ).toMatchObject({ call: { status: "cancelled" } });
    } finally {
      await reopened?.close();
      await h.close();
    }
  },
);

test.each(["allow_once", "deny", "cancel"] as const)(
  "an execution permission decision %s preserves its outcome until a native result",
  async (decision) => {
    const frames = scriptFrames();
    const tool: Fact = {
      type: "item.upsert",
      agent: "root",
      item: "execution",
      draft: {
        type: "tool_call",
        complete: false,
        call: {
          kind: "shell",
          title: "Offline",
          status: "awaiting_approval",
          detail: { kind: "shell", command: "offline" },
        },
      },
    };
    const request: Fact = {
      type: "interaction.opened",
      agent: "root",
      interaction: "approval",
      item: "execution",
      blocking: true,
      request: {
        kind: "approval",
        title: "Run?",
        options: [{ id: "decision", label: "Decide", kind: decision }],
      },
    };
    const h = await harness(
      [
        { on: "send", frames: [frames.frame(start, tool, request)] },
        {
          on: "resolve",
          frames: [
            frames.frame({
              type: "interaction.closed",
              interaction: "approval",
              state: "resolved",
            }),
          ],
        },
      ],
      frames,
      { permissionSettings: async () => ({ access: "ask" as const }) },
    );
    try {
      const id = await h.create();
      const interaction = Object.values(h.store.snapshotThread(id).interactions)[0];
      if (!interaction) throw new Error("Missing interaction");
      h.command({
        type: "interaction.resolve",
        interactionId: interaction.id,
        resolution: { kind: "approval", optionId: "decision" },
      });
      await h.engine.flush();
      expect(
        Object.values(h.store.snapshotThread(id).items).find((item) => item.type === "tool_call"),
      ).toMatchObject({
        complete: decision !== "allow_once",
        call: {
          status:
            decision === "allow_once" ? "running" : decision === "deny" ? "declined" : "cancelled",
        },
      });
      if (decision === "allow_once") {
        h.contexts[0]?.onFrame(
          frames.frame({
            type: "item.upsert",
            agent: "root",
            item: "execution",
            draft: {
              type: "tool_call",
              complete: true,
              call: { status: "succeeded", detail: { kind: "shell", exitCode: 0 } },
            },
          }),
        );
        await h.engine.flush();
        expect(
          Object.values(h.store.snapshotThread(id).items).find((item) => item.type === "tool_call"),
        ).toMatchObject({ complete: true, call: { status: "succeeded" } });
      }
    } finally {
      await h.close();
    }
  },
);
