import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { afterEach, expect, test } from "vitest";
import { spawnSupervisedStream } from "@ace/provider-kit/process";
import { ContextService, deliverContext, type ProjectionCapabilities } from "./index.ts";
import { repository, hash, png, thread } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const caps: ProjectionCapabilities = {
  provider: "codex",
  images: ["image/png"],
  documents: [],
  embeddedContext: false,
  maxInlineBytes: 1000,
};
async function fixture() {
  const repo = await repository();
  let id = 0;
  const service = await ContextService.open({
    root: join(repo.root, ".git", "context"),
    now: () => 1000,
    id: () => `upload-${++id}`,
    authorize: (device, target) => device === "device" && target === thread,
    workspace: () => repo.root,
  });
  cleanups.push(async () => {
    await service.close();
    await repo.close();
  });
  await repo.write("main.ts", "source");
  const begin = await service.uploads.handle("device", {
    op: "upload.begin",
    threadId: thread,
    sha256: hash(png),
    bytes: png.length,
    name: "phone.png",
  });
  if (begin.kind !== "upload") throw new Error("Expected upload");
  await service.uploads.handle("device", {
    op: "upload.chunk",
    uploadId: begin.uploadId,
    offset: 0,
    data: png.toString("base64"),
  });
  await service.uploads.handle("device", { op: "upload.commit", uploadId: begin.uploadId });
  const command = {
    id: "send",
    deviceId: "device",
    payload: {
      type: "thread.send",
      threadId: thread,
      input: [{ type: "text", text: "inspect" }],
      delivery: "queue",
      context: { mentions: [{ path: "main.ts" }], attachments: [{ sha256: hash(png) }] },
    },
  };
  return { ...repo, service, command };
}
test("thread send delivers native context to an owned CLI and releases only after consumption", async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  const received = Promise.withResolvers<unknown>();
  const sending = deliverContext(f.service, f.command, caps, async (message) => {
    entered.resolve();
    await resume.promise;
    // This is our own tiny protocol sink, never a real provider CLI.
    const child = spawnSupervisedStream({
      command: process.execPath,
      args: [
        "-e",
        `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{const m=JSON.parse(input);const p=m.context.input.find(p=>p.type==='localImage');process.stdout.write(JSON.stringify({text:m.input[0].text,parts:m.context.input,image:p?require('node:fs').readFileSync(p.path).toString('base64'):null}));});`,
      ],
      env: {},
      name: "owned-context-sink",
      maxOutputBytes: 8192,
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stdin.end(JSON.stringify(message));
    const exit = await child.exited;
    expect(exit.code).toBe(0);
    received.resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  });
  await entered.promise;
  try {
    await f.service.uploads.releaseThread(thread);
    expect(await f.service.uploads.collect()).toBe(0);
  } finally {
    resume.resolve();
    await sending.catch(() => {});
  }
  expect(await sending).toEqual([]);
  const result = z
    .object({ text: z.string(), parts: z.array(z.unknown()), image: z.string().nullable() })
    .parse(await received.promise);
  expect(result).toMatchObject({
    text: "inspect",
    parts: [{ type: "text", text: "File: main.ts\nsource" }, { type: "localImage" }],
    image: png.toString("base64"),
  });
  expect(await f.service.uploads.collect()).toBe(1);
});
test("a failed provider consumer releases pinned files and a denied command never reaches it", async () => {
  const f = await fixture();
  const consumed: string[] = [];
  await expect(
    deliverContext(f.service, { ...f.command, deviceId: "denied" }, caps, async () => {
      consumed.push("denied");
    }),
  ).rejects.toMatchObject({ code: "forbidden" });
  expect(consumed).toEqual([]);
  await expect(
    deliverContext(f.service, f.command, caps, async (message) => {
      if (message.context.provider !== "codex") throw new Error("Expected Codex");
      const part = message.context.input.find((p) => p.type === "localImage");
      expect(part?.type).toBe("localImage");
      if (part?.type === "localImage") expect(await readFile(part.path)).toEqual(png);
      throw new Error("consumer cancelled");
    }),
  ).rejects.toThrow("consumer cancelled");
  await f.service.uploads.releaseThread(thread);
  expect(await f.service.uploads.collect()).toBe(1);
});
