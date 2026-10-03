import { expect, test } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextService } from "./index.ts";
import { ThreadId, WorkspaceId, type ContextOperation } from "@ace/protocol";
import { hash } from "./test-support.ts";

test("a pre-thread upload survives restart and adoption authorizes only its device and workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-drafts-"));
  let sequence = 0;
  const options = {
    root: join(root, "context"),
    now: () => 1000,
    id: () => `id-${++sequence}`,
    authorize: (device: string, thread: string) => device === "phone" && thread === "created",
    workspaceRoot: (id: string) => (id === "workspace" ? root : undefined),
    workspace: (thread: string) => (thread === "created" ? join(root, "isolated") : undefined),
    threadWorkspaceRoot: (thread: string) => (thread === "created" ? root : undefined),
  };
  let service = await ContextService.open(options);
  const request = async (device: string, operation: ContextOperation) =>
    (
      await service.handle(device, {
        type: "context.request",
        requestId: `req-${++sequence}`,
        operation,
      })
    ).result;
  try {
    const draft = await request("phone", {
      op: "draft.create",
      workspaceId: WorkspaceId.parse("workspace"),
    });
    if (draft.kind !== "draft") throw new Error("Expected draft");
    const bytes = Buffer.from("draft bytes 雪");
    const sha256 = hash(bytes);
    const begin = await request("phone", {
      op: "draft.upload.begin",
      draftId: draft.draftId,
      sha256,
      bytes: bytes.length,
      name: "draft.txt",
    });
    if (begin.kind !== "upload") throw new Error("Expected upload");
    expect(
      await request("other-phone", { op: "upload.status", uploadId: begin.uploadId }),
    ).toMatchObject({ kind: "error", code: "not_found" });
    await request("phone", {
      op: "upload.chunk",
      uploadId: begin.uploadId,
      offset: 0,
      data: bytes.toString("base64"),
    });
    await request("phone", { op: "upload.commit", uploadId: begin.uploadId });
    await service.close();
    service = await ContextService.open(options);
    const prepared = await service.compose(
      "phone",
      "created",
      { draftId: draft.draftId, mentions: [], attachments: [{ sha256 }] },
      { provider: "codex", images: [], documents: [], embeddedContext: false, maxInlineBytes: 0 },
    );
    try {
      const attachment = await service.uploads.attachment("phone", "created", sha256);
      expect(await readFile(attachment.path)).toEqual(bytes);
    } finally {
      prepared.release();
    }
    await expect(
      service.compose(
        "other-phone",
        "created",
        { draftId: draft.draftId, mentions: [], attachments: [{ sha256 }] },
        { provider: "codex", images: [], documents: [], embeddedContext: false, maxInlineBytes: 0 },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(
      await request("phone", { op: "attachment.list", threadId: ThreadId.parse("created") }),
    ).toMatchObject({ kind: "attachments", attachments: [{ sha256, name: "draft.txt" }] });
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a draft cannot move its attachments to a different workspace or before upload completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-draft-boundary-"));
  let sequence = 0;
  const service = await ContextService.open({
    root: join(root, "context"),
    now: () => 1000,
    id: () => `id-${++sequence}`,
    authorize: () => true,
    workspaceRoot: () => root,
    workspace: (thread) => (thread === "other" ? root + "-other" : root),
  });
  try {
    const draft = (
      await service.handle("phone", {
        type: "context.request",
        requestId: "draft",
        operation: { op: "draft.create", workspaceId: WorkspaceId.parse("workspace") },
      })
    ).result;
    if (draft.kind !== "draft") throw new Error("Expected draft");
    await expect(service.uploads.adopt("phone", draft.draftId, "other")).rejects.toMatchObject({
      code: "forbidden",
    });
    const bytes = Buffer.from("not finished");
    await service.handle("phone", {
      type: "context.request",
      requestId: "begin",
      operation: {
        op: "draft.upload.begin",
        draftId: draft.draftId,
        sha256: hash(bytes),
        bytes: bytes.length,
        name: "draft.txt",
      },
    });
    await expect(service.uploads.adopt("phone", draft.draftId, "created")).rejects.toMatchObject({
      code: "busy",
    });
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
