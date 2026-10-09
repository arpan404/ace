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

test("Pi's native no-mode permission metadata remains readable before its adapter is admitted", async () => {
  const h = await harness([], scriptFrames());
  try {
    const client = await h.connect("preview");
    client.send({ type: "permissions.capabilities", requestId: "pi-native", provider: "pi" });
    const reply = await client.next();
    expect(reply).toMatchObject({
      type: "permissions.capabilities.result",
      ok: true,
      permissions: { permissionModes: [], modes: [] },
    });
  } finally {
    await h.close();
  }
});

test.each([
  { adapter: createClaudeAdapter(), version: "2.1.286", mode: "auto" },
  {
    adapter: createCodexAdapter(),
    version: "0.159.1",
    mode: '{"permissions":":workspace","approvalsReviewer":"auto_review"}',
  },
  {
    adapter: createCursorAdapter(),
    version: "1.0.35",
    mode: '{"sandboxOptions":{"enabled":true},"autoReview":true}',
  },
  { adapter: createOpenCodeAdapter(), version: "2.0.22", mode: "ask" },
])(
  "$adapter.provider absent settings dispatches an explicit predefined native mode",
  async ({ adapter, version, mode }) => {
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
      const id = await h.create();
      expect(h.contexts[0]?.permissionMode).toBe(mode);
      expect(h.store.getThread(id)?.permission?.effective).toBe(mode);
      expect(h.store.getThread(id)?.permission?.override).toBeNull();
    } finally {
      await h.close();
    }
  },
);

test.each([
  ["acceptEdits", "acceptEdits"],
  ["future-unavailable-mode", "auto"],
] as const)(
  "saved setting %s wins when supported and never delegates an unavailable mode to CLI defaults",
  async (configured, expected) => {
    const adapter = createClaudeAdapter();
    const frames = scriptFrames();
    const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames, {
      provider: "claude",
      capabilities: adapter.capabilities({
        installed: true,
        version: "2.1.286",
        auth: "logged_in",
        loginHint: "unused",
      }),
      permissionSettings: async () => configured,
    });
    try {
      const id = await h.create();
      expect(h.contexts[0]?.permissionMode).toBe(expected);
      expect(h.store.getThread(id)?.permission?.effective).toBe(expected);
      expect(h.store.getThread(id)?.permission?.override).toBeNull();
    } finally {
      await h.close();
    }
  },
);
