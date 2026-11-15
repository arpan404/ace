import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { ContextService } from "@ace/context";
import { ThreadId } from "@ace/protocol";
import { toolAttachment } from "./tool-result-content.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("files the daemon stores for a thread leave no upload records behind", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-tool-attachment-"));
  roots.push(root);
  let next = 0;
  const context = await ContextService.open({
    root,
    now: () => 1_000,
    id: () => `upload-${next++}`,
    authorize: () => true,
    workspace: () => root,
  });
  const threadId = ThreadId.parse("thread-tool-images");
  const stored = [];
  try {
    for (const text of ["first screenshot", "second screenshot", "third screenshot"])
      stored.push(
        await toolAttachment(context, { threadId }, Buffer.from(text), {
          name: "ace-tool-result.txt",
          mimeType: "text/plain",
        }),
      );
    for (const [index, file] of stored.entries()) {
      const held = await context.uploads.attachment("daemon-tool-result", threadId, file.sha256);
      expect(await readFile(held.path, "utf8")).toBe(
        ["first screenshot", "second screenshot", "third screenshot"][index],
      );
    }
  } finally {
    await context.close();
  }
  const db = new DatabaseSync(join(root, "context.sqlite"));
  try {
    expect(db.prepare("SELECT COUNT(*) AS count FROM uploads").get()).toEqual({ count: 0 });
  } finally {
    db.close();
  }
});
