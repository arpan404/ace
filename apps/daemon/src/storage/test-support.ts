import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextService } from "@ace/context";
import { Thread, WorkspaceId, type ThreadId } from "@ace/protocol";
import type { Services } from "../services/types.ts";
import { Store } from "../store.ts";
import { StorageService } from "./service.ts";

export const storageNow = 200 * 86400000;
export async function storageFixture(
  directory?: string,
  afterRemove?: (id: string) => Promise<void>,
) {
  const root = directory ?? (await realpath(await mkdtemp(join(tmpdir(), "ace-storage-"))));
  let clock = storageNow,
    sequence = 0;
  const now = () => clock;
  const store = new Store(
    join(root, "events.sqlite"),
    (error) => {
      throw error;
    },
    { now },
  );
  const workspace = store.createWorkspace(root, "Storage fixture", 1);
  const context = await ContextService.open({
    root: join(root, "context"),
    now,
    id: () => `upload-${++sequence}`,
    authorize: () => true,
    workspace: () => root,
  });
  const services: Partial<Services> = { context };
  const storage = new StorageService({
    root,
    now,
    id: () => `plan-${++sequence}`,
    store,
    services,
    ...(afterRemove ? { afterRemove } : {}),
  });
  const thread = (id: string, status: Thread["status"] = { state: "done" }) => {
    const t = Thread.parse({
      id,
      workspaceId: WorkspaceId.parse(workspace),
      title: id,
      provider: "codex",
      status,
      createdAt: 1,
      updatedAt: 1,
      archivedAt: 1,
    });
    store.appendEvents(t.id, [{ type: "thread.created", thread: t }], 1);
    return t;
  };
  const upload = async (id: ThreadId, bytes = Buffer.from("attachment body")) => {
    const hash = createHash("sha256").update(bytes).digest("hex");
    const begin = await context.uploads.handle("owner", {
      op: "upload.begin",
      threadId: id,
      name: "file.txt",
      bytes: bytes.length,
      sha256: hash,
    });
    if (begin.kind !== "upload") throw new Error("Upload admission failed");
    await context.uploads.handle("owner", {
      op: "upload.chunk",
      uploadId: begin.uploadId,
      offset: 0,
      data: bytes.toString("base64"),
    });
    await context.uploads.handle("owner", { op: "upload.commit", uploadId: begin.uploadId });
    return hash;
  };
  const file = async (path: string, contents = "old data") => {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), contents);
    await utimes(join(root, path), new Date(1), new Date(1));
    return join(root, path);
  };
  return {
    root,
    store,
    storage,
    services,
    thread,
    upload,
    file,
    advance: (ms: number) => {
      clock += ms;
    },
    async close() {
      await storage.close();
      await context.close();
      await store.close();
      if (!directory) await rm(root, { recursive: true, force: true });
    },
  };
}
