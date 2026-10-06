import { expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { createCodexAdapter } from "@ace/adapter-codex";
import type { Fact } from "@ace/core";
import { readFixture } from "@ace/adapter-testkit";
import {
  createClaudeAdapter,
  createTranslator,
  capabilities as claudeCapabilities,
} from "@ace/adapter-claude";
import {
  createOpenCodeAdapter,
  OpenCodeTranslator,
  capabilities as openCodeCapabilities,
} from "@ace/adapter-opencode";
import { ThreadId } from "@ace/protocol";
import type { ProviderAdapter } from "@ace/engine-api";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { harness, scriptFrames, start, end } from "./test-support.ts";

async function recordedFrames(path: string) {
  const fixture = await readFixture(
    fileURLToPath(new URL(`../../../../fixtures/${path}`, import.meta.url)),
  );
  return fixture.frames.map((frame) => {
    if (frame.channel !== "sdk") return frame;
    const payload = new ProviderPayload(JSON.stringify(frame.data));
    return Object.assign({}, frame, { data: payload.data, payload });
  });
}

for (const scenario of [
  {
    provider: "claude",
    path: "claude/2.1.286/approval-edit.jsonl",
    version: "2.1.286",
    capabilities: claudeCapabilities,
    translator: createTranslator,
  },
  {
    provider: "opencode",
    path: "opencode/2.0.22/muse-spark-1.3-contributor/approval-edit.jsonl",
    version: "2.0.22",
    capabilities: openCodeCapabilities,
    translator: (init) => new OpenCodeTranslator(init),
  },
] satisfies {
  provider: "claude" | "opencode";
  path: string;
  version: string;
  capabilities: ProviderAdapter["capabilities"];
  translator: ProviderAdapter["createTranslator"];
}[]) {
  test(`${scenario.provider} recorded edit approval stays pending in Ask until a human answers`, async () => {
    const frames = await recordedFrames(scenario.path);
    const probe = scenario.translator({ threadId: ThreadId.parse("probe"), rootKey: "root" });
    const approvalAt = frames.findIndex((frame) =>
      probe
        .translate(frame, frame.t)
        .some((fact) => fact.type === "interaction.opened" && fact.request.kind === "approval"),
    );
    if (approvalAt < 0) throw new Error("Recording has no approval request");
    const h = await harness(
      [
        { on: "send", frames: frames.slice(0, approvalAt + 1) },
        { on: "resolve", frames: frames.slice(approvalAt + 1) },
      ],
      scriptFrames(),
      {
        provider: scenario.provider,
        createTranslator: scenario.translator,
        capabilities: scenario.capabilities({
          installed: true,
          version: scenario.version,
          auth: "logged_in",
          loginHint: "unused",
        }),
      },
    );
    try {
      const receipt = h.command({
        type: "thread.create",
        workspaceId: h.workspace,
        provider: scenario.provider,
        permissionMode: "ask",
        input: [{ type: "text", text: "Edit the file" }],
      });
      if (!receipt.threadId) throw new Error("No thread");
      await h.engine.flush();
      const interaction = Object.values(h.store.snapshotThread(receipt.threadId).interactions).find(
        (entry) => entry.state === "pending" && entry.request.kind === "approval",
      );
      if (!interaction || interaction.request.kind !== "approval")
        throw new Error("Missing approval card");
      expect(h.store.getThread(receipt.threadId)?.status.state).toBe("needs_you");
      expect(h.adapter.commands.filter((command) => command.type === "resolve")).toEqual([]);
      const once = interaction.request.options.find((option) => option.kind === "allow_once");
      if (!once) throw new Error("No one-shot approval");
      expect(
        h.command({
          type: "interaction.resolve",
          interactionId: interaction.id,
          resolution: { kind: "approval", optionId: once.id },
        }).ok,
      ).toBe(true);
      await h.engine.flush();
      expect(h.store.getInteraction(interaction.id)?.state).toBe("resolved");
      expect(h.store.getThread(receipt.threadId)?.status.state).toBe("done");
    } finally {
      await h.close();
    }
  });
}

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
    const nativeFrames = await recordedFrames(path);
    const translator = adapter.createTranslator({
      threadId: ThreadId.parse("recorded"),
      rootKey: "root",
    });
    let approval: Extract<Fact, { type: "interaction.opened" }> | undefined;
    for (const frame of nativeFrames) {
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
