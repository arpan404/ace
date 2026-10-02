import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { ThreadId, type ContextResult } from "@ace/protocol";
import { GitWorkspace, UploadStore, type UploadLimits } from "./index.ts";

export const run = promisify(execFile);
export const thread = ThreadId.parse("thread");
export const otherThread = ThreadId.parse("other-thread");
export function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6ioAAAAASUVORK5CYII=",
  "base64",
);
export async function repository() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-context-")));
  await run("git", ["init", "--quiet", root]);
  const workspace = new GitWorkspace(root);
  return {
    root,
    workspace,
    async write(path: string, value: string | Uint8Array) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), value);
    },
    async close() {
      await rm(root, { recursive: true, force: true });
    },
  };
}
export async function uploads(limits: Partial<UploadLimits> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-uploads-")));
  let counter = 0,
    now = 1000;
  const allowed = new Set([thread, otherThread]);
  const options = {
    root,
    id: () => `upload-${++counter}`,
    now: () => now,
    limits,
    authorize: (device: string, value: string) =>
      device === "device" && [...allowed].some((item) => item === value),
  };
  let store = await UploadStore.open(options);
  const begin = async (bytes: Buffer, target = thread, sha256 = hash(bytes), name = "file.txt") => {
    const result = await store.handle("device", {
      op: "upload.begin",
      threadId: target,
      bytes: bytes.length,
      sha256,
      name,
    });
    if (result.kind !== "upload") throw new Error("Expected upload response");
    return result.uploadId;
  };
  const chunk = (uploadId: string, bytes: Buffer, offset = 0) =>
    store.handle("device", {
      op: "upload.chunk",
      uploadId,
      offset,
      data: bytes.toString("base64"),
    });
  const commit = (uploadId: string) => store.handle("device", { op: "upload.commit", uploadId });
  const put = async (bytes: Buffer, target = thread, name = "file.txt") => {
    const id = await begin(bytes, target, hash(bytes), name);
    await chunk(id, bytes);
    return commit(id);
  };
  return {
    root,
    get store() {
      return store;
    },
    begin,
    chunk,
    commit,
    put,
    allowed,
    advance(ms: number) {
      now += ms;
    },
    async restart() {
      await store.close();
      store = await UploadStore.open(options);
    },
    async close() {
      await store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
export function attachment(result: ContextResult["result"]) {
  if (result.kind !== "attachment") throw new Error("Expected attachment response");
  return result.attachment;
}
