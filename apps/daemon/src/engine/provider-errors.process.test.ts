import { expect, test } from "vitest";
import { createClaudeAdapter } from "@ace/adapter-claude";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { harness, scriptFrames } from "./test-support.ts";

function native(seq: number, data: unknown, dir: "recv" | "stderr" = "recv") {
  if (dir === "stderr") return { seq, t: seq, channel: "stderr", dir, data };
  const payload = new ProviderPayload(JSON.stringify(data));
  return { seq, t: seq, channel: "sdk", dir, data: payload.data, payload };
}

test("Claude model rejection renders readable notices and retains codes and provider evidence", async () => {
  const claude = createClaudeAdapter();
  const warning = '[claude-code:unrecognized_model] {"model":"opus-5.5","query_source":"sdk"}';
  const failed = {
    type: "assistant",
    error: "model_not_found",
    message: {
      id: "rejection",
      content: [{ type: "text", text: "Selected model is unavailable." }],
    },
  };
  const adapter = createScriptedAdapter({
    provider: "claude",
    capabilities: claude.capabilities({
      installed: true,
      auth: "logged_in",
      loginHint: "unused",
      version: "2.1.286",
    }),
    nativeSessionId: "scripted",
    createTranslator: (init) => claude.createTranslator(init),
    steps: [
      {
        on: "send",
        frames: [
          native(1, { type: "system", subtype: "init", session_id: "scripted", model: "opus-5.5" }),
          native(2, warning, "stderr"),
          native(3, failed),
          native(4, { type: "result", is_error: true, result: "model_not_found" }),
        ],
      },
    ],
  });
  const h = await harness([], scriptFrames(), { provider: "claude", nativeAdapter: adapter });
  try {
    const id = await h.create();
    const view = h.store.snapshotThread(id);
    const notices = Object.values(view.items).filter((item) => item.type === "notice");
    expect(notices).toContainEqual(
      expect.objectContaining({
        text: expect.stringContaining('Claude could not use the selected model "opus-5.5"'),
        code: "unrecognized_model",
        title: "Model not recognised",
        detail: warning,
        details: { code: "unrecognized_model", provider: "claude", model: "opus-5.5" },
        raw: [expect.objectContaining({ data: warning })],
      }),
    );
    expect(notices).toContainEqual(
      expect.objectContaining({
        text: expect.stringContaining("Claude could not use the selected model"),
        code: "model_not_found",
        title: expect.stringContaining("Claude Code"),
        detail: "Selected model is unavailable.",
        details: expect.objectContaining({ code: "model_not_found", provider: "claude" }),
      }),
    );
    expect(
      notices.some(
        (item) =>
          item.type === "notice" &&
          (item.text === "model_not_found" || item.text.startsWith("[claude-code:")),
      ),
    ).toBe(false);
    expect(view.thread.status.state).toBe("failed");
    expect(Object.values(view.agents)).toContainEqual(
      expect.objectContaining({
        status: {
          state: "failed",
          error: expect.objectContaining({
            message: expect.stringContaining("Claude could not use the selected model"),
            code: "model_not_found",
            details: { code: "model_not_found", provider: "claude", model: "opus-5.5" },
          }),
        },
      }),
    );
    expect(h.errors).toEqual([]);
  } finally {
    await h.close();
  }
});

test("unknown provider errors and assistant prose remain intact", async () => {
  const claude = createClaudeAdapter();
  const unknown = "[claude-code:new_error] future metadata";
  const prose = "The sample intentionally returns model_not_found.";
  const adapter = createScriptedAdapter({
    provider: "claude",
    capabilities: claude.capabilities({
      installed: true,
      auth: "logged_in",
      loginHint: "unused",
      version: "2.1.286",
    }),
    nativeSessionId: "scripted",
    createTranslator: (init) => claude.createTranslator(init),
    steps: [
      {
        on: "send",
        frames: [
          native(1, { type: "system", subtype: "init", session_id: "scripted" }),
          native(2, unknown, "stderr"),
          native(3, {
            type: "assistant",
            message: { id: "prose", content: [{ type: "text", text: prose }] },
          }),
          native(4, { type: "result", is_error: false }),
        ],
      },
    ],
  });
  const h = await harness([], scriptFrames(), { provider: "claude", nativeAdapter: adapter });
  try {
    const id = await h.create();
    const items = h.store.readItemPage(id, h.store.headSeq() + 1, 50).items;
    expect(items).toContainEqual(expect.objectContaining({ type: "notice", text: unknown }));
    expect(items).toContainEqual(
      expect.objectContaining({
        type: "message",
        role: "assistant",
        parts: [expect.objectContaining({ type: "text", text: prose })],
      }),
    );
    expect(h.store.getThread(id)?.status.state).toBe("done");
  } finally {
    await h.close();
  }
});

// Not executed: tests run at merge. These native codes previously broke frame commits.
test.each(["constructor", "__proto__", "toString", "hasOwnProperty"])(
  "unknown %s provider errors remain notices and do not poison subsequent frames",
  async (code) => {
    const claude = createClaudeAdapter();
    const warning = `[claude-code:${code}] {}`;
    const adapter = createScriptedAdapter({
      provider: "claude",
      capabilities: claude.capabilities({
        installed: true,
        auth: "logged_in",
        loginHint: "unused",
        version: "2.1.286",
      }),
      nativeSessionId: "scripted",
      createTranslator: (init) => claude.createTranslator(init),
      steps: [
        {
          on: "send",
          frames: [
            native(1, { type: "system", subtype: "init", session_id: "scripted" }),
            native(2, warning, "stderr"),
            native(3, {
              type: "assistant",
              message: {
                id: "after-unknown",
                content: [{ type: "text", text: "Continued after unknown error" }],
              },
            }),
            native(4, { type: "result", is_error: false }),
          ],
        },
      ],
    });
    const h = await harness([], scriptFrames(), { provider: "claude", nativeAdapter: adapter });
    try {
      const id = await h.create();
      const items = h.store.readItemPage(id, h.store.headSeq() + 1, 50).items;
      expect(items).toContainEqual(expect.objectContaining({ type: "notice", text: warning }));
      expect(items).toContainEqual(
        expect.objectContaining({
          type: "message",
          role: "assistant",
          parts: [expect.objectContaining({ text: "Continued after unknown error" })],
        }),
      );
      expect(h.store.getThread(id)?.status.state).toBe("done");
      expect(h.errors).toEqual([]);
    } finally {
      await h.close();
    }
  },
);
