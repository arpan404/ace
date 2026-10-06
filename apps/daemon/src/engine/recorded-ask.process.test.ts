import { expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { readFixture } from "@ace/adapter-testkit";
import { createCodexAdapter } from "@ace/adapter-codex";
import { createClaudeAdapter } from "@ace/adapter-claude";
import { createOpenCodeAdapter } from "@ace/adapter-opencode";
import { ThreadId } from "@ace/protocol";
import type { Fact } from "@ace/core";
import { harness, scriptFrames, start, end } from "./test-support.ts";

const recordings = [
  { adapter: createCodexAdapter(), path: "codex/0.159.1/approval-edit.jsonl" },
  { adapter: createClaudeAdapter(), path: "claude/2.1.286/approval-edit.jsonl" },
  {
    adapter: createOpenCodeAdapter(),
    path: "opencode/2.0.22/muse-spark-1.3-contributor/approval-edit.jsonl",
  },
];

test.each(recordings)(
  "$path stays waiting for a human and grants only the recorded action once",
  async ({ adapter, path }) => {
    const fixture = await readFixture(
      fileURLToPath(new URL(`../../../../fixtures/${path}`, import.meta.url)),
    );
    const translator = adapter.createTranslator({
      threadId: ThreadId.parse("recorded"),
      rootKey: "root",
    });
    let approval: Extract<Fact, { type: "interaction.opened" }> | undefined;
    for (const frame of fixture.frames) {
      approval = translator
        .translate(frame, frame.t)
        .find(
          (fact): fact is Extract<Fact, { type: "interaction.opened" }> =>
            fact.type === "interaction.opened" &&
            fact.request.kind === "approval" &&
            fact.request.options.some((option) => option.kind === "allow_once"),
        );
      if (approval) break;
    }
    if (!approval || approval.request.kind !== "approval")
      throw new Error("Recording has no approval");
    const option = approval.request.options.find((entry) => entry.kind === "allow_once");
    if (!option) throw new Error("Recording has no one-shot decision");
    const frames = scriptFrames();
    const h = await harness(
      [
        {
          on: "send",
          frames: [
            frames.frame(start, { ...approval, agent: "root", interaction: "recorded-approval" }),
          ],
        },
        { on: "resolve", frames: [frames.frame(end)] },
      ],
      frames,
      { provider: adapter.provider, permissionSettings: async () => "ask" },
    );
    try {
      const id = await h.create();
      const view = h.store.snapshotThread(id);
      const interaction = Object.values(view.interactions).find(
        (i) => i.request.kind === "approval",
      );
      if (!interaction) throw new Error("Missing approval card");
      expect(interaction.state).toBe("pending");
      expect(view.thread.permission?.effective).toBe("ask");
      expect(view.thread.status.state).toBe("needs_you");
      const result = h.command({
        type: "interaction.resolve",
        interactionId: interaction.id,
        resolution: { kind: "approval", optionId: option.id },
      });
      expect(result.ok).toBe(true);
      await h.engine.flush();
      expect(h.store.getThread(id)?.status.state).toBe("done");
      expect(h.store.snapshotThread(id).interactions[interaction.id]?.resolution).toMatchObject({
        kind: "approval",
        optionId: option.id,
      });
      expect(
        h.command({
          type: "interaction.resolve",
          interactionId: interaction.id,
          resolution: { kind: "approval", optionId: option.id },
        }).ok,
      ).toBe(false);
    } finally {
      await h.close();
    }
  },
);
