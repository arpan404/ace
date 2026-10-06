import { afterEach, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { ContextService } from "@ace/context";
import { fixture, cleanupRecovery, text } from "./recovery-test-support.ts";
import { scriptFrames, start, end } from "./test-support.ts";
import { prepareQueuedInput } from "../services/recovery.ts";
import type { PrepareInput } from "./input.ts";

afterEach(cleanupRecovery);
for (const provider of ["codex", "pi"] as const) {
  test(`${provider} context resolution fallback reaches the notice stream and sends remaining input`, async () => {
    const frames = scriptFrames();
    let prepare: PrepareInput | undefined;
    const h = await fixture(
      [
        { on: "send", frames: [frames.frame(start, end)] },
        { on: "send", frames: [frames.frame(start, end)] },
      ],
      frames,
      {
        prepareInput: async (...args) => {
          if (!prepare) throw new Error("Preparation unavailable");
          return prepare(...args);
        },
      },
    );
    const adapter = h.registry.get("codex").adapter;
    if (provider === "pi")
      h.registry.register(
        { ...adapter, provider },
        {
          installed: true,
          auth: "logged_in",
          loginHint: "unused",
        },
      );
    h.command({ type: "thread.create", workspaceId: h.workspace, provider, input: text("first") });
    await h.engine.flush();
    const id = h.store.listThreads()[0]?.id;
    if (!id) throw new Error("Missing thread");
    await promisify(execFile)("git", ["init", "-q", h.home]);
    const workspace = await realpath(h.home);
    const context = await ContextService.open({
      root: `${h.home}/context`,
      workspace: () => workspace,
      authorize: () => true,
      now: h.clock.now,
      id: () => "upload",
    });
    try {
      prepare = prepareQueuedInput({ services: { context } });
      const sent = h.command({
        type: "thread.send",
        threadId: id,
        input: text("inspect remaining input"),
        context: { mentions: [{ path: "missing.txt" }], attachments: [] },
      });
      expect(sent.error).toBeUndefined();
      await h.engine.flush();
      expect(
        Object.values(h.store.snapshotThread(id).items).filter(
          (item) => item.type === "notice" && item.level === "error",
        ),
      ).toEqual([]);
      expect(
        Object.values(h.store.snapshotThread(id).items).some(
          (item) =>
            item.type === "notice" && item.level === "warning" && item.text.includes("missing.txt"),
        ),
      ).toBe(true);
      expect(h.adapter.commands.findLast((command) => command.type === "send")).toMatchObject({
        input: text("inspect remaining input"),
      });
    } finally {
      await context.close();
    }
  });
}

test("uploaded text reaches Codex inline and starts its turn without an unsupported-file refusal", async () => {
  const { createHash } = await import("node:crypto");
  const frames = scriptFrames();
  let prepare: PrepareInput | undefined;
  const h = await fixture(
    [
      { on: "send", frames: [frames.frame(start, end)] },
      { on: "send", frames: [frames.frame(start, end)] },
    ],
    frames,
    {
      prepareInput: async (...args) => {
        if (!prepare) throw new Error("Preparation unavailable");
        return prepare(...args);
      },
    },
  );
  const id = await h.create();
  const context = await ContextService.open({
    root: `${h.home}/context`,
    workspace: () => undefined,
    authorize: () => true,
    now: h.clock.now,
    id: () => "upload",
  });
  try {
    const bytes = Buffer.from("QA_ATTACHMENT_TOKEN");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const begin = await context.handle("device", {
      type: "context.request",
      requestId: "begin",
      operation: {
        op: "upload.begin",
        threadId: id,
        name: "qa-note.txt",
        bytes: bytes.length,
        sha256,
      },
    });
    if (begin.result.kind !== "upload") throw new Error("Upload failed");
    await context.handle("device", {
      type: "context.request",
      requestId: "chunk",
      operation: {
        op: "upload.chunk",
        uploadId: begin.result.uploadId,
        offset: 0,
        data: bytes.toString("base64"),
      },
    });
    await context.handle("device", {
      type: "context.request",
      requestId: "commit",
      operation: { op: "upload.commit", uploadId: begin.result.uploadId },
    });
    prepare = prepareQueuedInput({ services: { context } });
    expect(
      h.command(
        {
          type: "thread.send",
          threadId: id,
          input: text("Read the token"),
          context: { mentions: [], attachments: [{ sha256 }] },
        },
        "device",
        "text-attachment",
      ).ok,
    ).toBe(true);
    await h.engine.flush();
    const sent = h.adapter.commands.findLast((command) => command.type === "send");
    if (sent?.type !== "send") throw new Error("No provider input");
    expect(sent.input).toEqual([
      ...text("Read the token"),
      {
        type: "text",
        text: expect.stringContaining("<ace-attachment>\nQA_ATTACHMENT_TOKEN\n</ace-attachment>"),
      },
    ]);
    expect(JSON.stringify(sent.input)).toContain("qa-note.txt");
    expect(h.engine.queue(id).messages).toEqual([]);
    const snapshot = h.store.snapshotThread(id);
    expect(snapshot.items["input:text-attachment"]).toMatchObject({
      type: "message",
      role: "user",
      attachments: [
        expect.objectContaining({
          sha256,
          name: "qa-note.txt",
          kind: "text",
          delivery: "inline_text",
        }),
      ],
    });
    expect(
      Object.values(snapshot.items).filter(
        (item) => item.type === "notice" && item.level === "error",
      ),
    ).toEqual([]);
  } finally {
    await context.close();
  }
});
