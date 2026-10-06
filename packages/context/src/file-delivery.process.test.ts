import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ContextService, canonicalContext, type ProjectionCapabilities } from "./index.ts";
import { hash, thread } from "./test-support.ts";

test("all files survive restart, classify by bytes and reach native, inline or readable path input", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-file-context-"));
  let id = 0;
  let exists = true;
  const options = {
    root,
    now: () => 1000,
    id: () => `file-${++id}`,
    authorize: () => true,
    threadExists: () => exists,
    workspace: () => undefined,
  };
  let service = await ContextService.open(options);
  const put = async (name: string, bytes: Buffer) => {
    const begun = await service.uploads.handle("device", {
      op: "upload.begin",
      threadId: thread,
      sha256: hash(bytes),
      bytes: bytes.length,
      name,
    });
    if (begun.kind !== "upload") throw new Error("Missing upload reservation");
    for (let offset = 0; offset < bytes.length; offset += 65536)
      await service.uploads.handle("device", {
        op: "upload.chunk",
        uploadId: begun.uploadId,
        offset,
        data: bytes.subarray(offset, offset + 65536).toString("base64"),
      });
    const result = await service.uploads.handle("device", {
      op: "upload.commit",
      uploadId: begun.uploadId,
    });
    if (result.kind !== "attachment") throw new Error("Missing attachment");
    return result.attachment;
  };
  try {
    const small = Buffer.from("export const answer = 42;");
    const utf16 = Buffer.concat([Buffer.from([255, 254]), Buffer.from("Unicode ✓", "utf16le")]);
    const files = [
      await put("unknown.extension", small),
      await put("windows.log", utf16),
      await put("large.ts", Buffer.alloc(100000, 97)),
      await put("report.pdf", Buffer.from("%PDF-1.7\nexample")),
      await put("archive.zip", Buffer.from([80, 75, 3, 4, 0, 255])),
      await put("empty.txt", Buffer.alloc(0)),
      await put("late-binary.txt", Buffer.concat([Buffer.alloc(65536, 97), Buffer.from([255, 0])])),
    ];
    expect(files.map((file) => file.kind)).toEqual([
      "text",
      "text",
      "text",
      "pdf",
      "binary",
      "text",
      "binary",
    ]);
    const original = await service.uploads.attachment("device", thread, files[0]?.sha256 ?? "");
    const before = await stat(original.path);
    await put("duplicate.ts", small);
    expect((await stat(original.path)).ino).toBe(before.ino);
    expect(before.mode & 0o222).toBe(0);
    await service.close();
    service = await ContextService.open(options);
    for (const provider of ["claude", "codex", "opencode", "acp"] as const) {
      const caps: ProjectionCapabilities = {
        provider,
        images: [],
        documents: provider === "claude" ? ["application/pdf"] : provider === "acp" ? ["*"] : [],
        embeddedContext: provider === "acp",
        maxInlineBytes: 4 * 1024 * 1024,
      };
      const result = await service.compose(
        "device",
        thread,
        { mentions: [], attachments: files.map((file) => ({ sha256: file.sha256 })) },
        caps,
      );
      try {
        expect(result.attachments).toHaveLength(files.length);
        expect(result.attachments.every((file) => file.delivery !== undefined)).toBe(true);
        const serialized = JSON.stringify(canonicalContext(result.projection));
        expect(serialized).toContain("Unicode ✓");
        expect(serialized).toContain("Inline text truncated");
        expect(serialized).toContain("language: ts");
        expect(result.attachments[3]?.delivery).toBe(
          provider === "claude"
            ? "native_pdf"
            : provider === "acp"
              ? "native_resource"
              : "file_path",
        );
        const binary = await service.uploads.attachment("device", thread, files[4]?.sha256 ?? "");
        expect(await readFile(binary.path)).toEqual(Buffer.from([80, 75, 3, 4, 0, 255]));
        expect(serialized).toContain(provider === "acp" ? "blob" : binary.path);
        expect(result.diagnostics).toEqual([]);
      } finally {
        result.release();
      }
    }
    // Reconcile a thread deleted while the daemon was stopped.
    await service.close();
    exists = false;
    service = await ContextService.open(options);
    await service.uploads.collect();
    await expect(readFile(original.path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("message size limits explain how to send retained files without releasing their references", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-file-limit-"));
  const service = await ContextService.open({
    root,
    now: () => 1,
    id: () => "limited",
    authorize: () => true,
    workspace: () => undefined,
    limits: { messageBytes: 3 },
  });
  try {
    const bytes = Buffer.from("four");
    await service.uploads.handle("device", {
      op: "upload.begin",
      threadId: thread,
      sha256: hash(bytes),
      bytes: 4,
      name: "four.txt",
    });
    await service.uploads.handle("device", {
      op: "upload.chunk",
      uploadId: "limited",
      offset: 0,
      data: bytes.toString("base64"),
    });
    await service.uploads.handle("device", { op: "upload.commit", uploadId: "limited" });
    await expect(
      service.compose(
        "device",
        thread,
        { mentions: [], attachments: [{ sha256: hash(bytes) }] },
        { provider: "codex", images: [], documents: [], embeddedContext: false, maxInlineBytes: 0 },
      ),
    ).rejects.toMatchObject({
      code: "quota",
      message: expect.stringContaining("send them in separate messages"),
    });
    expect(
      await readFile((await service.uploads.attachment("device", thread, hash(bytes))).path),
    ).toEqual(bytes);
    await rm((await service.uploads.attachment("device", thread, hash(bytes))).path);
    const wider = await ContextService.open({
      root,
      now: () => 1,
      id: () => "unused",
      authorize: () => true,
      workspace: () => undefined,
    });
    try {
      await expect(
        wider.compose(
          "device",
          thread,
          { mentions: [], attachments: [{ sha256: hash(bytes) }] },
          {
            provider: "codex",
            images: [],
            documents: [],
            embeddedContext: false,
            maxInlineBytes: 0,
          },
        ),
      ).rejects.toMatchObject({
        code: "not_found",
        message: expect.stringContaining("Upload the file again"),
      });
    } finally {
      await wider.close();
    }
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
