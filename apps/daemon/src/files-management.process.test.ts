import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { afterEach, expect, test } from "vitest";
import { DeviceId, ThreadId, FilesServerMessage, type FileOperation } from "@ace/protocol";
import { Client } from "./socket-test-support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
const execute = promisify(execFile);
async function launch(home: string, root: string) {
  const source = `
    import { startDaemon, createDevThread } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
    const daemon = await startDaemon({ config: { dataDir: ${JSON.stringify(join(home, "data"))}, host: "127.0.0.1", port: 0, listen: "local", remotePort: 0, logLevel: "silent" } });
    const workspace = daemon.store.createWorkspace(${JSON.stringify(root)}, "Files test");
    const thread = createDevThread(daemon.store, workspace);
    process.send({ url: daemon.url, tokenPath: daemon.tokenPath, threadId: thread.id });
    process.once("SIGTERM", () => { void daemon.close().then(() => process.exit(0)); });
  `;
  const entry = join(home, "entry.mjs");
  await writeFile(entry, source);
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      PATH: "/usr/bin:/bin",
      ACE_HOME: home,
      ACE_HISTORY_INSTANCES: "[]",
      ACE_MODEL_INSTANCES: "[]",
      ACE_RELAY_URL: "",
      ACE_SCREEN_HELPER: "",
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const exited = once(child, "close");
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
  };
  cleanup.push(stop);
  const ready = await Promise.race([
    once(child, "message").then(([value]) =>
      z.object({ url: z.string(), tokenPath: z.string(), threadId: ThreadId }).parse(value),
    ),
    exited.then(() => {
      throw new Error("Files daemon exited before publishing readiness");
    }),
  ]);
  const client = new Client(ready.url);
  cleanup.push(() => client.close());
  await once(client.socket, "open");
  client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("files-test"),
    token: (await readFile(ready.tokenPath, "utf8")).trim(),
  });
  expect(await client.next()).toMatchObject({ type: "welcome" });
  let sequence = 0;
  const request = async (operation: FileOperation) => {
    client.send({
      type: "files.request",
      requestId: `file-${++sequence}`,
      threadId: ready.threadId,
      operation,
    });
    for (;;) {
      const value = FilesServerMessage.parse(await client.next());
      if (value.type !== "files.changed") return value;
    }
  };
  const download = async (
    operation: Extract<FileOperation, { op: "archive.download" | "download" }>,
  ) => {
    const readyFile = await request(operation);
    if (readyFile.type !== "files.ready") throw new Error("No download channel");
    const chunks: Buffer[] = [];
    for (;;) {
      client.send({
        type: "files.pull",
        requestId: `pull-${++sequence}`,
        channel: readyFile.channel,
      });
      let frame = FilesServerMessage.parse(await client.next());
      while (frame.type === "files.changed") frame = FilesServerMessage.parse(await client.next());
      if (frame.type !== "files.data") throw new Error("No file bytes");
      if (frame.eof) return Buffer.concat(chunks);
      chunks.push(Buffer.from(frame.data, "base64"));
    }
  };
  return { client, request, download, stop };
}

test("a separate daemon process restores deleted contents after restart and downloads a previewed archive", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-files-management-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const root = join(home, "checkout");
  await mkdir(root);
  await mkdir(join(root, "docs"));
  await mkdir(join(root, ".cache"));
  await writeFile(join(root, "docs", "notes.txt"), "Keep these edits\n");
  await writeFile(join(root, ".gitignore"), ".cache/\n");
  await writeFile(join(root, ".cache", "build.log"), "Ignored build output\n");
  await execute("git", ["init", "-q", root]);
  let daemon = await launch(home, root);
  const stat = z
    .object({ value: z.object({ version: z.string() }) })
    .parse(await daemon.request({ op: "stat", path: "docs" }));
  const removed = z
    .object({ value: z.object({ trashId: z.string() }) })
    .parse(await daemon.request({ op: "delete", path: "docs", expected: stat.value.version }));
  await expect(readFile(join(root, "docs", "notes.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  await daemon.client.close();
  await daemon.stop();
  daemon = await launch(home, root);
  expect(await daemon.request({ op: "trash.list", limit: 64 })).toMatchObject({
    value: { entries: [expect.objectContaining({ id: removed.value.trashId, path: "docs" })] },
  });
  expect(
    await daemon.request({
      op: "restore",
      trashId: removed.value.trashId,
      path: "docs",
      expected: null,
    }),
  ).toMatchObject({ type: "files.result" });
  expect(await daemon.download({ op: "download", path: "docs/notes.txt", offset: 0 })).toEqual(
    Buffer.from("Keep these edits\n"),
  );
  expect(await daemon.request({ op: "trash.list", limit: 64 })).toMatchObject({
    value: { entries: [] },
  });
  expect(await daemon.request({ op: "list", path: "", limit: 1000 })).toMatchObject({
    value: { paths: expect.arrayContaining(["docs/", "docs/notes.txt"]), truncated: false },
  });
  const preview = z.object({
    value: z.object({ previewId: z.string(), entries: z.number(), bytes: z.number() }),
  });
  const normal = preview.parse(
    await daemon.request({ op: "archive.preview", path: "", includeIgnored: false }),
  ).value;
  const archive = join(home, "normal.tar.gz");
  await writeFile(
    archive,
    await daemon.download({ op: "archive.download", previewId: normal.previewId }),
  );
  const unpack = join(home, "unpacked");
  await mkdir(unpack);
  await execute("tar", ["-xzf", archive, "-C", unpack]);
  expect(await readFile(join(unpack, "docs", "notes.txt"), "utf8")).toBe("Keep these edits\n");
  await expect(readFile(join(unpack, ".cache", "build.log"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  const included = preview.parse(
    await daemon.request({ op: "archive.preview", path: "", includeIgnored: true }),
  ).value;
  expect(included.entries).toBeGreaterThan(normal.entries);
  expect(included.bytes).toBeGreaterThan(normal.bytes);
  await writeFile(
    archive,
    await daemon.download({ op: "archive.download", previewId: included.previewId }),
  );
  await execute("tar", ["-xzf", archive, "-C", unpack]);
  expect(await readFile(join(unpack, ".cache", "build.log"), "utf8")).toBe(
    "Ignored build output\n",
  );
});
