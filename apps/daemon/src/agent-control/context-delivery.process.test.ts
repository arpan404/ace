import { mkdir } from "node:fs/promises";
import { expect, test } from "vitest";
import { Command } from "@ace/protocol";
import { commandContext } from "../commands.ts";
import { daemonFixture } from "./daemon-test-support.ts";

// Covers authorization and delivery at the daemon boundary, beyond the pure summary test.
test("daemon delivers budgeted thread context with paging pointers and denies a foreign workspace", async () => {
  const f = await daemonFixture();
  try {
    const source = f.controls.delegations.delegate(f.caller, {
      requestId: "context-source",
      provider: "claude",
      task: "work",
      role: "worker",
      wait: false,
      estimatedLoad: 0,
    });
    await f.daemon.engine?.flush();
    const ctx = f.h.contexts.get(source.childId);
    if (!ctx) throw new Error("Missing source context");
    ctx.onFrame(
      f.h.frames.frame({
        type: "item.upsert",
        agent: "root",
        item: "reference-result",
        draft: {
          type: "message",
          role: "assistant",
          parts: [{ type: "text", text: "🙂界".repeat(3000) }],
          complete: true,
        },
      }),
    );
    await f.daemon.engine?.flush();
    const send = Command.parse({
      id: "reference-send",
      deviceId: "ui",
      payload: {
        type: "thread.send",
        threadId: f.caller.threadId,
        input: [{ type: "text", text: "use the context" }],
        delivery: "queue",
        context: {
          mentions: [],
          attachments: [],
          items: [{ type: "thread_ref", threadId: source.childId, budgetBytes: 1024 }],
        },
      },
    });
    expect(f.daemon.engine?.handler.handle(send, commandContext(f.daemon.store)).ok).toBe(true);
    // Source still holds the tree, so stop it before expecting delivery.
    await f.controls.port.execute(
      f.caller,
      { op: "thread.interrupt", threadId: source.childId, requestId: "stop-source" },
      new AbortController().signal,
    );
    await f.daemon.engine?.flush();
    const history = [...f.h.nativeHistories.values()].find((messages) =>
      messages.includes("use the context"),
    );
    const summary = history?.find(
      (text) => text.includes("reference-result") || text.includes("Pointer:"),
    );
    expect(summary).toBeDefined();
    expect(summary).toContain(source.childId);
    expect(summary).toContain("Untrusted");
    expect(summary).toContain("truncated");
    expect(Buffer.byteLength(summary?.split("\nPointer:")[0] ?? "")).toBeLessThanOrEqual(1024);
    const foreignPath = f.h.home + "/foreign";
    await mkdir(foreignPath);
    const workspace = f.daemon.store.createWorkspace(foreignPath, "foreign");
    const foreign = f.controls.delegations.command("foreign-create", {
      type: "thread.create",
      workspaceId: workspace,
      provider: "codex",
      input: [{ type: "text", text: "foreign secret" }],
    });
    if (!foreign.ok || !foreign.threadId) throw new Error("Foreign thread failed");
    await f.daemon.engine?.flush();
    expect(
      f.controls.delegations.command("foreign-reference", {
        type: "thread.send",
        threadId: f.caller.threadId,
        input: [{ type: "text", text: "must not deliver" }],
        delivery: "queue",
        context: {
          mentions: [],
          attachments: [],
          items: [{ type: "thread_ref", threadId: foreign.threadId, budgetBytes: 1024 }],
        },
      }).ok,
    ).toBe(true);
    await f.daemon.engine?.flush();
    expect([...f.h.nativeHistories.values()].flat()).not.toContain("must not deliver");
    expect(
      f.daemon.store
        .readItemPage(f.caller.threadId, f.daemon.store.headSeq() + 1, 20)
        .items.some(
          (item) => item.type === "notice" && item.detail?.includes("Thread context access denied"),
        ),
    ).toBe(true);
  } finally {
    await f.daemon.close();
  }
});
