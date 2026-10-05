import type { ProviderErrorDetails } from "@ace/protocol";
import { expect, test } from "vitest";
import type { SessionContext } from "@ace/engine-api";
import { harness, scriptFrames, start, end } from "./test-support.ts";

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
          detail: expect.stringContaining("model must be provider/model"),
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
        detail: expect.stringContaining("No provider match"),
      }),
    );
    expect(JSON.stringify({ warnings, items })).not.toContain("private-open-secret");
  } finally {
    await h.close();
  }
});

test.each([false, true])(
  "a throwing diagnostic hook preserves the safe opening failure and releases the aborted session (async=%s)",
  async (asynchronous) => {
    const frames = scriptFrames();
    const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames, {
      limits: { maxActiveThreads: 1 },
      onSessionOpenFailure: () => {
        if (asynchronous) return Promise.reject(new Error("diagnostic callback private-value"));
        throw new Error("diagnostic callback private-value");
      },
    });
    let context: SessionContext | undefined;
    try {
      h.registry.register(
        {
          ...h.adapter,
          async openSession(ctx) {
            context = ctx;
            ctx.onFrame(frames.frame({ type: "process.started" }));
            throw new Error('Cannot select model: {"credentials":["opaque-login-value"]}');
          },
        },
        { installed: true, auth: "logged_in", loginHint: "unused" },
      );
      const id = await h.create();
      expect(context?.signal.aborted).toBe(true);
      expect(h.engine.queue(id)).toMatchObject({
        paused: true,
        reason: "manual",
        messages: [{ state: "queued" }],
      });
      const snapshot = h.store.snapshotThread(id);
      expect(Object.values(snapshot.items)).toContainEqual(
        expect.objectContaining({
          type: "notice",
          detail: expect.stringContaining("Cannot select model"),
          details: expect.objectContaining({ code: "session_open_failed" }),
        }),
      );
      expect(JSON.stringify({ snapshot, errors: h.errors })).not.toContain("private-value");
      expect(JSON.stringify(snapshot)).not.toContain("opaque-login-value");
      expect(h.adapter.commands.filter((command) => command.type === "send")).toEqual([]);
      h.registry.register(h.adapter, { installed: true, auth: "logged_in", loginHint: "unused" });
      expect(
        h.command({
          type: "queue.resume",
          threadId: id,
          expectedRevision: h.engine.queue(id).revision,
        }).ok,
      ).toBe(true);
      await h.engine.flush();
      expect(h.adapter.commands.filter((command) => command.type === "send")).toHaveLength(1);
      expect(h.engine.queue(id).messages).toEqual([]);
    } finally {
      await h.close();
    }
  },
);

test.each([
  '{"credentials":["opaque-login-value"]}',
  '{"credentials":{"login":"opaque-login-value"}}',
  JSON.stringify(JSON.stringify({ credentials: ["opaque-login-value"] })),
  'password="opaque login value"',
  'Rejected {"credentials":["opaque-login-value"',
])(
  "persisted opening notices and diagnostic callbacks remove embedded credential values: %s",
  async (detail) => {
    const warnings: ProviderErrorDetails[] = [];
    const h = await harness([], scriptFrames(), {
      onSessionOpenFailure: (_id, failure) => {
        warnings.push(failure);
      },
    });
    try {
      h.registry.register(
        {
          ...h.adapter,
          async openSession() {
            throw new Error(`Cannot select model: ${detail}`);
          },
        },
        { installed: true, auth: "logged_in", loginHint: "unused" },
      );
      const id = await h.create();
      const items = h.store.readItemPage(id, h.store.headSeq() + 1, 50).items;
      expect(items).toContainEqual(
        expect.objectContaining({
          type: "notice",
          detail: expect.stringContaining("Cannot select model"),
          details: warnings[0],
        }),
      );
      expect(warnings).toHaveLength(1);
      expect(JSON.stringify({ items, warnings })).not.toContain("opaque-login-value");
      expect(JSON.stringify({ items, warnings })).not.toContain("opaque login value");
      expect(h.engine.queue(id).messages).toMatchObject([{ state: "queued" }]);
      expect(h.adapter.commands.filter((command) => command.type === "send")).toEqual([]);
    } finally {
      await h.close();
    }
  },
);

test("an open failure clears a persisted uncertainty flag when no provider input was sent", async () => {
  const h = await harness([], scriptFrames());
  try {
    h.registry.register(
      {
        ...h.adapter,
        async openSession(ctx) {
          // Emulate an old persisted flag at the storage boundary while open is in flight.
          h.store.atomic((db) =>
            db
              .prepare("UPDATE intents SET uncertain=1 WHERE thread_id=? AND status='running'")
              .run(ctx.threadId),
          );
          throw new Error("Cannot open directory");
        },
      },
      { installed: true, auth: "logged_in", loginHint: "unused" },
    );
    const id = await h.create();
    const queue = h.engine.queue(id);
    expect(queue.messages).toMatchObject([{ state: "queued" }]);
    const message = queue.messages[0];
    if (!message) throw new Error("Missing retained input");
    expect(
      h.command({
        type: "queue.edit",
        threadId: id,
        messageId: message.id,
        expectedRevision: queue.revision,
        input: [{ type: "text", text: "retry" }],
      }).ok,
    ).toBe(true);
    expect(h.adapter.commands.filter((command) => command.type === "send")).toEqual([]);
  } finally {
    await h.close();
  }
});
