import { expect, test } from "vitest";
import { createCodexAdapter } from "@ace/adapter-codex";
import { createClaudeAdapter } from "@ace/adapter-claude";
import { createOpenCodeAdapter } from "@ace/adapter-opencode";
import { createCursorAdapter } from "@ace/adapter-cursor";
import { createPiAdapter } from "@ace/adapter-pi";
import { harness, scriptFrames, start, end } from "./test-support.ts";
const providers = [
  { adapter: createCodexAdapter(), version: "0.159.1", mode: ":workspace", label: "Auto" },
  {
    adapter: createClaudeAdapter(),
    version: "2.1.286",
    mode: "acceptEdits",
    label: "Accept edits",
  },
  { adapter: createOpenCodeAdapter(), version: "2.0.0", mode: "deny", label: "Deny" },
  {
    adapter: createCursorAdapter(),
    version: "1.0.35",
    mode: '{"sandboxOptions":{"enabled":false},"autoReview":true}',
    label: "Auto review · sandbox disabled",
  },
  { adapter: createPiAdapter(), version: "0.85.1", mode: undefined, label: undefined },
];
test.each(providers)(
  "$adapter.provider catalog and execution preserve native selectors",
  async ({ adapter, version, mode, label }) => {
    const frames = scriptFrames();
    const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames, {
      provider: adapter.provider,
      capabilities: adapter.capabilities({
        installed: true,
        version,
        auth: "logged_in",
        loginHint: "unused",
      }),
    });
    try {
      const client = await h.connect("preview");
      client.send({
        type: "permissions.capabilities",
        requestId: "catalog",
        provider: adapter.provider,
      });
      const reply = await client.next();
      if (reply.type !== "permissions.capabilities.result") throw new Error("Missing catalog");
      if (mode)
        expect(reply.permissions?.permissionModes).toContainEqual(
          expect.objectContaining({ id: mode, label }),
        );
      else expect(reply.permissions?.permissionModes).toEqual([]);
      const result = h.command({
        type: "thread.create",
        workspaceId: h.workspace,
        provider: adapter.provider,
        ...(mode ? { permissionMode: mode } : {}),
        input: [{ type: "text", text: "fake" }],
      });
      expect(result.ok).toBe(true);
      await h.engine.flush();
      expect(h.contexts[0]?.permissionMode).toBe(mode);
      if (!result.threadId) throw new Error("No thread");
      expect(Object.values(h.store.snapshotThread(result.threadId).runs)[0]).toMatchObject({
        provider: adapter.provider,
        permissionMode: mode ?? null,
      });
    } finally {
      await h.close();
    }
  },
);
