import { expect, test } from "vitest";
import { codexCapabilities } from "@ace/adapter-codex";
import { cursorCapabilities } from "@ace/adapter-cursor";
import { genericQuirks } from "@ace/adapter-acp";
import { harness, scriptFrames, start, end } from "./test-support.ts";

for (const [provider, capabilities] of [
  [
    "codex",
    codexCapabilities({
      installed: true,
      version: "0.159.1",
      auth: "unknown",
      loginHint: "unused",
    }),
  ],
  ["cursor", cursorCapabilities],
  ["antigravity", genericQuirks.capabilities()],
] as const) {
  test(`${provider} refuses Ask before admitting a command when it cannot gate every action`, async () => {
    const frames = scriptFrames();
    const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames, {
      provider,
      capabilities,
    });
    try {
      expect(
        h.command({
          type: "thread.create",
          workspaceId: h.workspace,
          provider,
          permissionMode: "ask",
          input: [{ type: "text", text: "Append a line to README with a shell command" }],
        }),
      ).toMatchObject({ ok: false, error: "permission_mode_unsupported" });
      await h.engine.flush();
      expect(h.store.listThreads()).toEqual([]);
      expect(h.adapter.commands).toEqual([]);
    } finally {
      await h.close();
    }
  });

  test(`${provider} retains inherited Ask input without opening a weaker provider session`, async () => {
    const frames = scriptFrames();
    const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames, {
      provider,
      capabilities,
      permissionSettings: async () => "ask",
    });
    try {
      const receipt = h.command({
        type: "thread.create",
        workspaceId: h.workspace,
        provider,
        input: [{ type: "text", text: "Append a line using the shell" }],
      });
      if (!receipt.threadId) throw new Error("No retained thread");
      await h.engine.flush();
      expect(h.store.getThread(receipt.threadId)?.status.state).toBe("waiting");
      expect(h.engine.queue(receipt.threadId).messages).toMatchObject([
        { state: "queued", input: [{ type: "text", text: "Append a line using the shell" }] },
      ]);
      expect(h.contexts).toEqual([]);
      expect(h.adapter.commands).toEqual([]);
      expect(
        h.command({
          type: "thread.permission.set",
          threadId: receipt.threadId,
          permissionMode: "ask",
        }),
      ).toMatchObject({ ok: false, error: "permission_mode_unsupported" });
    } finally {
      await h.close();
    }
  });
}
