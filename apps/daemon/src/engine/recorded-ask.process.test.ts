import { expect, test } from "vitest";
import { readFixture } from "@ace/adapter-testkit";
import { createTranslator, capabilities as claudeCapabilities } from "@ace/adapter-claude";
import { OpenCodeTranslator, capabilities as openCodeCapabilities } from "@ace/adapter-opencode";
import { ThreadId } from "@ace/protocol";
import type { ProviderAdapter } from "@ace/engine-api";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { harness, scriptFrames } from "./test-support.ts";

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
    const fixture = await readFixture(
      new URL(`../../../../fixtures/${scenario.path}`, import.meta.url).pathname,
    );
    const frames = fixture.frames.map((frame) => {
      if (frame.channel !== "sdk") return frame;
      const payload = new ProviderPayload(JSON.stringify(frame.data));
      return Object.assign({}, frame, { data: payload.data, payload });
    });
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
