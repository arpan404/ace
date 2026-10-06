import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { ContextService } from "@ace/context";
import { Capabilities, Command, type ThreadId } from "@ace/protocol";
import { Engine } from "@ace/daemon";
import { prepareQueuedInput } from "../services/recovery.ts";
import { harness, scriptFrames, start, end } from "./test-support.ts";

const capabilities = Capabilities.parse({
  steer: false,
  interruptCascades: false,
  resume: true,
  fork: false,
  subagentTranscripts: true,
  backgroundTaskControl: false,
  backgroundVisibility: "none",
  planMode: false,
  tokenUsage: false,
  imageInput: false,
  rewindFiles: false,
  attachmentInput: {
    format: "claude",
    documents: ["application/pdf"],
    embeddedContext: false,
    maxInlineBytes: 4096,
  },
});
async function upload(service: ContextService, threadId: ThreadId, name: string, bytes: Buffer) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const begun = await service.uploads.handle("device", {
    op: "upload.begin",
    threadId,
    name,
    bytes: bytes.length,
    sha256,
  });
  if (begun.kind !== "upload") throw new Error("No reservation");
  await service.uploads.handle("device", {
    op: "upload.chunk",
    uploadId: begun.uploadId,
    offset: 0,
    data: bytes.toString("base64"),
  });
  await service.uploads.handle("device", { op: "upload.commit", uploadId: begun.uploadId });
  return { sha256 };
}

test("a held send keeps text, PDF and binary attachments across engine and storage restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-engine-files-"));
  let sequence = 0;
  const options = {
    root,
    now: () => 1000,
    id: () => `attachment-${++sequence}`,
    authorize: () => true,
    workspace: () => undefined,
  };
  let context = await ContextService.open(options);
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames, {
    capabilities,
    prepareInput: (command, provider, caps) =>
      prepareQueuedInput({ services: { context } })(command, provider, caps),
  });
  let engine = h.engine;
  try {
    const id = await h.create();
    const attachments = [
      await upload(context, id, "code.ts", Buffer.from("export const answer = 42;")),
      await upload(context, id, "report.pdf", Buffer.from("%PDF-1.7\nexample")),
      await upload(context, id, "archive.zip", Buffer.from([80, 75, 3, 4, 0, 255])),
    ];
    expect(
      h.command({ type: "queue.pause", threadId: id, expectedRevision: engine.queue(id).revision })
        .ok,
    ).toBe(true);
    expect(
      h.command(
        {
          type: "thread.send",
          threadId: id,
          input: [{ type: "text", text: "Read all files" }],
          context: { mentions: [], attachments },
        },
        "device",
        "files-send",
      ).ok,
    ).toBe(true);
    await engine.flush();
    expect(h.adapter.commands.filter((command) => command.type === "send")).toHaveLength(1);
    await engine.close();
    await context.close();
    context = await ContextService.open(options);
    engine = new Engine(h.store, {
      registry: h.registry,
      clock: h.clock,
      prepareInput: (command, provider, caps) =>
        prepareQueuedInput({ services: { context } })(command, provider, caps),
    });
    await engine.flush();
    expect(engine.queue(id).messages[0]?.context?.attachments).toEqual(attachments);
    const resume = Command.parse({
      id: "resume-files",
      deviceId: "device",
      payload: { type: "queue.resume", threadId: id, expectedRevision: engine.queue(id).revision },
    });
    expect(engine.handler.handle(resume, h.store).ok).toBe(true);
    await engine.flush();
    const sends = h.adapter.commands.filter((command) => command.type === "send");
    const sent = sends.at(-1);
    if (sent?.type !== "send") throw new Error("No provider input");
    expect(JSON.stringify(sent.input)).toContain("export const answer = 42;");
    expect(sent.input).toContainEqual(
      expect.objectContaining({
        type: "file",
        mimeType: "application/pdf",
        content: { encoding: "base64", data: Buffer.from("%PDF-1.7\nexample").toString("base64") },
      }),
    );
    const binary = await context.uploads.attachment("device", id, attachments[2]?.sha256 ?? "");
    expect(JSON.stringify(sent.input)).toContain(binary.path);
    expect(await readFile(binary.path)).toEqual(Buffer.from([80, 75, 3, 4, 0, 255]));
    expect(h.store.snapshotThread(id).items["input:files-send"]).toMatchObject({
      attachments: [
        expect.objectContaining({ kind: "text", delivery: "inline_text" }),
        expect.objectContaining({ kind: "pdf", delivery: "native_pdf" }),
        expect.objectContaining({ kind: "binary", delivery: "file_path" }),
      ],
    });
    // Capabilities, not the provider's name, select delivery: this scripted provider is Codex.
    const prepared = await prepareQueuedInput({ services: { context } })(
      Command.parse({
        id: "fallback",
        deviceId: "device",
        payload: {
          type: "thread.send",
          threadId: id,
          input: [{ type: "text", text: "fallback" }],
          context: { mentions: [], attachments },
        },
      }),
      "codex",
      {
        ...capabilities,
        attachmentInput: {
          format: "codex",
          documents: [],
          embeddedContext: false,
          maxInlineBytes: 0,
        },
      },
    );
    try {
      expect(prepared.attachments?.[1]?.delivery).toBe("file_path");
    } finally {
      prepared.release();
    }
    const execution = h.contexts.at(-1);
    if (!execution) throw new Error("No provider boundary");
    await execution.onFrame(
      frames.frame({
        type: "interaction.opened",
        agent: "root",
        interaction: "read-attached",
        blocking: true,
        request: {
          kind: "approval",
          title: "Read attachment",
          target: { tool: "Read", access: "read", paths: [binary.path] },
          options: [
            { id: "once", label: "Allow", kind: "allow_once" },
            { id: "deny", label: "Deny", kind: "deny" },
          ],
        },
      }),
    );
    await engine.flush();
    expect(
      Object.values(h.store.snapshotThread(id).interactions).find(
        (entry) => entry.request.kind === "approval" && entry.request.title === "Read attachment",
      ),
    ).toMatchObject({ state: "resolved", review: { decision: "approve" } });
    await execution.onFrame(
      frames.frame({
        type: "interaction.opened",
        agent: "root",
        interaction: "write-attached",
        blocking: true,
        request: {
          kind: "approval",
          title: "Write attachment",
          target: { tool: "Write", access: "write", paths: [binary.path] },
          options: [
            { id: "once", label: "Allow", kind: "allow_once" },
            { id: "deny", label: "Deny", kind: "deny" },
          ],
        },
      }),
    );
    await engine.flush();
    expect(
      Object.values(h.store.snapshotThread(id).interactions).find(
        (entry) => entry.request.kind === "approval" && entry.request.title === "Write attachment",
      ),
    ).toMatchObject({ state: "pending", review: { decision: "escalate" } });
  } finally {
    await engine.close();
    await h.close();
    await context.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an over-limit message explains the correction and never reaches the provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-engine-file-limit-"));
  let sequence = 0;
  const context = await ContextService.open({
    root,
    now: () => 1000,
    id: () => `limited-${++sequence}`,
    authorize: () => true,
    workspace: () => undefined,
    limits: { messageBytes: 3 },
  });
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames, {
    capabilities,
    prepareInput: prepareQueuedInput({ services: { context } }),
  });
  try {
    const id = await h.create();
    const reference = await upload(context, id, "four.txt", Buffer.from("four"));
    expect(
      h.command(
        {
          type: "thread.send",
          threadId: id,
          input: [{ type: "text", text: "Read four.txt" }],
          context: { mentions: [], attachments: [reference] },
        },
        "device",
        "too-large",
      ).ok,
    ).toBe(true);
    await h.engine.flush();
    expect(h.adapter.commands.filter((command) => command.type === "send")).toHaveLength(1);
    expect(Object.values(h.store.snapshotThread(id).items)).toContainEqual(
      expect.objectContaining({
        type: "notice",
        level: "error",
        commandId: "too-large",
        detail: expect.stringContaining("send them in separate messages"),
      }),
    );
  } finally {
    await h.close();
    await context.close();
    await rm(root, { recursive: true, force: true });
  }
});
