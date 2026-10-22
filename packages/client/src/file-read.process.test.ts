import { afterEach, expect, test, vi } from "vitest";
import { chunkFilesChannel, FilesService } from "@ace/files";
import { FILE_READ_PART, ThreadId, type FilesServerMessage } from "@ace/protocol";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, type FileReader } from "./file-read.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const step of cleanup.splice(0)) await step();
});

/**
 * A real files service behind the daemon's chunk channel, answering `files.request`s the way a
 * socket would. `seen` records each read's reply; `onRead` runs before each read is handled.
 */
async function checkout(onRead?: (offset: number) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "ace-file-read-"));
  const root = join(home, "workspace");
  await mkdir(root);
  const service = await FilesService.create({
    workspace: root,
    dataDir: join(home, "data"),
    now: Date.now,
    id: randomUUID,
    authorize: () => true,
  });
  type Reply = Awaited<ReturnType<FileReader["request"]>>;
  const waiting = new Map<string, (message: Reply) => void>();
  const seen: FilesServerMessage[] = [];
  const channel = chunkFilesChannel({
    device: "viewer",
    resolve: async () => ({ service, allowed: () => true }),
    send(message) {
      seen.push(message);
      if (
        (message.type === "files.result" ||
          message.type === "files.error" ||
          message.type === "files.ready") &&
        message.requestId
      )
        waiting.get(message.requestId)?.(message);
    },
  });
  cleanup.push(async () => {
    channel.close();
    await service.close();
    await rm(home, { recursive: true, force: true });
  });
  const client: FileReader = {
    async request(input) {
      if (input.operation.op === "read") await onRead?.(input.operation.offset ?? 0);
      const requestId = randomUUID();
      const reply = new Promise<Reply>((resolve) => waiting.set(requestId, resolve));
      channel.accept({ ...input, requestId });
      return reply;
    },
  };
  return { root, client, seen };
}

const threadId = ThreadId.parse("thread");
const read = (client: FileReader, path: string, maxSize = 2 * 1024 * 1024) =>
  readFile(client, { threadId, path, maxSize });

test("a small file arrives with its details in a single reply", async () => {
  const c = await checkout();
  await writeFile(join(c.root, "small.ts"), "export const answer = 42;\n");
  const result = await read(c.client, "small.ts");
  expect(result.kind === "file" && new TextDecoder().decode(result.bytes)).toBe(
    "export const answer = 42;\n",
  );
  expect(c.seen).toHaveLength(1);
});

test("a source file larger than one part arrives whole and compressed on the wire", async () => {
  const c = await checkout();
  const text = Array.from(
    { length: 12_000 },
    (_, n) => `export function handler${n}(input: string) { return input; }\n`,
  ).join("");
  expect(text.length).toBeGreaterThan(2 * FILE_READ_PART);
  await writeFile(join(c.root, "big.ts"), text);
  const result = await read(c.client, "big.ts");
  expect(result.kind === "file" && new TextDecoder().decode(result.bytes)).toBe(text);
  const sent = c.seen.reduce(
    (sum, m) => sum + (m.type === "files.result" ? JSON.stringify(m.value).length : 0),
    0,
  );
  expect(sent).toBeLessThan(text.length / 3);
});

test("a platform that can't expand gzip is sent the file's plain bytes", async () => {
  vi.stubGlobal("DecompressionStream", undefined);
  const c = await checkout();
  const text = "export const line = 1;\n".repeat(20_000);
  await writeFile(join(c.root, "plain.ts"), text);
  const result = await read(c.client, "plain.ts");
  expect(result.kind === "file" && new TextDecoder().decode(result.bytes)).toBe(text);
  const encodings = c.seen.map((m) => (m.type === "files.result" ? m.value.encoding : undefined));
  expect(encodings.length).toBeGreaterThan(1);
  expect(encodings.every((encoding) => encoding !== "gzip")).toBe(true);
});

test("missing files, folders and files over the limit come back without bytes", async () => {
  const c = await checkout();
  await mkdir(join(c.root, "src"));
  await writeFile(join(c.root, "huge.log"), "x".repeat(4096));
  expect(await read(c.client, "gone.ts")).toEqual({ kind: "missing" });
  expect(await read(c.client, "src")).toEqual({ kind: "folder" });
  expect(await read(c.client, "huge.log", 1024)).toMatchObject({ kind: "large", size: 4096 });
});

test("a file rewritten between its parts is read again and never mixes versions", async () => {
  let rewrite = true;
  const c = await checkout(async (offset) => {
    if (offset > 0 && rewrite) {
      rewrite = false;
      await writeFile(join(c.root, "moving.txt"), "b".repeat(FILE_READ_PART + 10));
    }
  });
  await writeFile(join(c.root, "moving.txt"), "a".repeat(FILE_READ_PART + 10));
  const result = await read(c.client, "moving.txt");
  expect(result.kind === "file" && new TextDecoder().decode(result.bytes)).toBe(
    "b".repeat(FILE_READ_PART + 10),
  );
});
