import type { ProviderErrorDetails } from "@ace/protocol";
import { expect, test } from "vitest";
import { harness, scriptFrames } from "./test-support.ts";

for (const exit of [false, true])
  test(`a failed open retains input as queued before any provider send (exit callback=${exit})`, async () => {
    const frames = scriptFrames();
    const warnings: ProviderErrorDetails[] = [];
    const h = await harness([], frames, {
      onSessionOpenFailure: (_id, details) => warnings.push(details),
    });
    try {
      h.registry.register(
        {
          ...h.adapter,
          async openSession(ctx) {
            ctx.onFrame(frames.frame({ type: "process.started" }));
            if (exit) ctx.onExit({ deliberate: true });
            throw new Error("model must be provider/model");
          },
        },
        { installed: true, auth: "logged_in", loginHint: "unused" },
      );
      const id = await h.create();
      expect(h.engine.queue(id)).toMatchObject({
        paused: true,
        reason: "manual",
        messages: [{ state: "queued", input: [{ type: "text", text: "first" }] }],
      });
      expect(warnings).toEqual([
        {
          provider: "codex",
          code: "session_open_failed",
          title: "codex session opening failed",
          detail: "model must be provider/model",
        },
      ]);
      expect(h.adapter.commands.filter((command) => command.type === "send")).toEqual([]);
      const notices = Object.values(h.store.snapshotThread(id).items).filter(
        (item) => item.type === "notice",
      );
      expect(notices.some((item) => item.text.includes("execution is uncertain"))).toBe(false);
      expect(notices).toContainEqual(
        expect.objectContaining({
          text: expect.stringContaining("model must be provider/model"),
          details: expect.objectContaining({ code: "session_open_failed", provider: "codex" }),
        }),
      );
    } finally {
      await h.close();
    }
  });

test("structured open failures reach diagnostics and stored notices with the same redacted detail", async () => {
  const warnings: ProviderErrorDetails[] = [];
  const h = await harness([], scriptFrames(), {
    onSessionOpenFailure: (_id, details) => warnings.push(details),
  });
  try {
    h.registry.register(
      {
        ...h.adapter,
        async openSession() {
          throw {
            code: "invalid_model",
            title: "Model unavailable",
            detail: `No provider match; api_key=private-open-secret ${"x".repeat(5000)}`,
          };
        },
      },
      { installed: true, auth: "logged_in", loginHint: "unused" },
    );
    const id = await h.create();
    const failure = warnings[0];
    expect(warnings).toHaveLength(1);
    expect(failure).toMatchObject({
      provider: "codex",
      code: "invalid_model",
      title: "Model unavailable",
      detail: expect.stringContaining("No provider match"),
    });
    expect(failure?.detail?.length).toBe(2048);
    const items = h.store.readItemPage(id, h.store.headSeq() + 1, 50).items;
    expect(items).toContainEqual(
      expect.objectContaining({
        type: "notice",
        details: failure,
        text: expect.stringContaining("No provider match"),
      }),
    );
    expect(JSON.stringify({ warnings, items })).not.toContain("private-open-secret");
  } finally {
    await h.close();
  }
});
