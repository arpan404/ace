import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { ContextService } from "@ace/context";
import type { ThreadId } from "@ace/protocol";
import { prepareQueuedInput } from "../services/recovery.ts";
import { transitionHarness } from "./transition-test-support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "ace-continuation-files-"));
  let sequence = 0;
  const context = await ContextService.open({
    root,
    now: () => 1000,
    id: () => `attachment-${++sequence}`,
    authorize: () => true,
    workspace: () => undefined,
  });
  const h = transitionHarness({
    cursorBackend: "cursor-sdk",
    prepareInput: (command, provider, capabilities, continued) =>
      prepareQueuedInput({ services: { context } })(command, provider, capabilities, continued),
  });
  cleanup.push(async () => {
    await h.close();
    await context.close();
    await rm(root, { recursive: true, force: true });
  });
  return { h, context };
}

async function upload(context: ContextService, threadId: ThreadId, name: string, bytes: Buffer) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const begun = await context.uploads.handle("device", {
    op: "upload.begin",
    threadId,
    name,
    bytes: bytes.length,
    sha256,
  });
  if (begun.kind !== "upload") throw new Error("No reservation");
  await context.uploads.handle("device", {
    op: "upload.chunk",
    uploadId: begun.uploadId,
    offset: 0,
    data: bytes.toString("base64"),
  });
  await context.uploads.handle("device", { op: "upload.commit", uploadId: begun.uploadId });
  return { sha256 };
}

async function cursorThread(h: ReturnType<typeof transitionHarness>) {
  expect(
    h.command({
      type: "thread.create",
      provider: "cursor",
      workspaceId: h.workspace,
      input: [{ type: "text", text: "source history" }],
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  const id = h.store.listThreads()[0]?.id;
  if (!id) throw new Error("No Cursor thread");
  return id;
}

const carrying = (h: ReturnType<typeof transitionHarness>, text: string) =>
  h.inputs.filter((input) => input.text.includes(text));

test("a Cursor thread continued on Codex delivers the message and its files once, and keeps its own copies", async () => {
  const { h, context } = await setup();
  const source = await cursorThread(h);
  const attachments = [
    await upload(context, source, "notes.txt", Buffer.from("remember the margin")),
    await upload(context, source, "report.pdf", Buffer.from("%PDF-1.7\nexample")),
  ];
  const result = h.command({
    type: "thread.fork",
    threadId: source,
    point: { type: "turn", runId: h.finishedRun(source).id },
    input: "next message",
    selection: { provider: "codex", options: {} },
    context: { mentions: [], attachments },
    budgetBytes: 16384,
  });
  expect(result.ok).toBe(true);
  await h.engine.flush();
  const fork = result.forkThreadId;
  if (!fork) throw new Error("No continuation");

  const delivered = carrying(h, "next message");
  expect(delivered).toHaveLength(1);
  expect(delivered[0]?.provider).toBe("codex");
  expect(delivered[0]?.text).toContain("source history");
  expect(delivered[0]?.text).toContain("remember the margin");
  expect(carrying(h, "remember the margin")).toHaveLength(1);
  // Both threads hold the files: the new one has its own reference, the source keeps its own.
  for (const attachment of attachments)
    expect((await context.uploads.attachment("device", fork, attachment.sha256)).path).toBe(
      (await context.uploads.attachment("device", source, attachment.sha256)).path,
    );
  expect(
    h.command({
      type: "thread.send",
      threadId: source,
      delivery: "queue",
      input: [{ type: "text", text: "again on Cursor" }],
      context: { mentions: [], attachments: [attachments[0]!] },
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(carrying(h, "again on Cursor")).toEqual([
    expect.objectContaining({ provider: "cursor", text: expect.stringContaining("remember") }),
  ]);
});

test("a continuation naming a file its source never held sends nothing", async () => {
  const { h } = await setup();
  const source = await cursorThread(h);
  const result = h.command({
    type: "thread.fork",
    threadId: source,
    point: { type: "turn", runId: h.finishedRun(source).id },
    input: "next message",
    selection: { provider: "codex", options: {} },
    context: { mentions: [], attachments: [{ sha256: "a".repeat(64) }] },
    budgetBytes: 16384,
  });
  expect(result.ok).toBe(true);
  await h.engine.flush();
  expect(carrying(h, "next message")).toHaveLength(0);
  const notices = Object.values(h.store.snapshotThread(result.forkThreadId!).items).filter(
    (item) => item.type === "notice" && item.level === "error",
  );
  expect(notices.length).toBeGreaterThan(0);
});
