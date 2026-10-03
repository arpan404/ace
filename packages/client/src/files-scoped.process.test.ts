import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ThreadId, Thread } from "@ace/protocol";
import { setup, ready } from "./test-support.ts";

async function* source(bytes: Uint8Array) {
  for (let offset = 0; offset < bytes.length; offset += 65536)
    yield bytes.subarray(offset, offset + 65536);
}
test("binary files round-trip in bounded chunks in the thread workspace without a global workspace root", async () => {
  const f = await setup();
  try {
    const { client } = f.make();
    await promisify(execFile)("git", ["init", f.directory]);
    await ready(client);
    const bytes = Uint8Array.from({ length: 170000 }, (_, index) => index % 256);
    const digest = createHash("sha256").update(bytes).digest("hex");
    await client.uploadFile(
      {
        threadId: f.thread.id,
        path: "binary.dat",
        expected: null,
        size: bytes.length,
        sha256: digest,
      },
      source(bytes),
    );
    expect(await readFile(join(f.directory, "binary.dat"))).toEqual(Buffer.from(bytes));
    const chunks: Uint8Array[] = [];
    for await (const chunk of client.downloadFile({
      threadId: f.thread.id,
      op: "download",
      path: "binary.dat",
      offset: 0,
    }))
      chunks.push(chunk);
    expect(chunks.every((chunk) => chunk.length <= 65536)).toBe(true);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(bytes));
    await expect(
      client.uploadFile(
        {
          threadId: f.thread.id,
          path: "binary.dat",
          expected: null,
          size: bytes.length,
          sha256: digest,
        },
        source(bytes),
      ),
    ).rejects.toMatchObject({ message: "CONFLICT" });
    const unrelated = join(f.directory, "other");
    await mkdir(unrelated);
    await promisify(execFile)("git", ["init", unrelated]);
    await writeFile(join(unrelated, "binary.dat"), "other workspace");
    const workspaceId = f.daemon.store.createWorkspace(unrelated, "Other");
    const other = Thread.parse({
      id: "other",
      workspaceId,
      title: "Other",
      provider: "codex",
      createdAt: 1,
      updatedAt: 1,
      status: { state: "new" },
    });
    f.daemon.store.appendEvents(other.id, [{ type: "thread.created", thread: other }]);
    const data: Uint8Array[] = [];
    for await (const chunk of client.downloadFile({
      threadId: other.id,
      op: "download",
      path: "binary.dat",
      offset: 0,
    }))
      data.push(chunk);
    expect(Buffer.concat(data).toString()).toBe("other workspace");
    await expect(
      client
        .downloadFile({
          threadId: ThreadId.parse("unknown"),
          op: "download",
          path: "binary.dat",
          offset: 0,
        })
        .next(),
    ).rejects.toMatchObject({ code: "daemon" });
    await expect(
      client
        .downloadFile({ threadId: f.thread.id, op: "download", path: "../token", offset: 0 })
        .next(),
    ).rejects.toMatchObject({ code: "daemon" });
  } finally {
    await f.cleanup();
  }
});

test("closing a partial file download releases its channel and rejected digests never replace a destination", async () => {
  const f = await setup();
  try {
    const { client } = f.make();
    await promisify(execFile)("git", ["init", f.directory]);
    await writeFile(join(f.directory, "source.dat"), Buffer.alloc(90000, 7));
    await ready(client);
    for (let index = 0; index < 8; index++) {
      const download = client.downloadFile({
        threadId: f.thread.id,
        op: "download",
        path: "source.dat",
        offset: 0,
      });
      expect((await download.next()).value?.length).toBe(65536);
      await download.return(undefined);
    }
    const bytes = new Uint8Array([0, 255, 1]);
    await expect(
      client.uploadFile(
        {
          threadId: f.thread.id,
          path: "rejected.dat",
          expected: null,
          size: bytes.length,
          sha256: "0".repeat(64),
        },
        source(bytes),
      ),
    ).rejects.toMatchObject({ code: "daemon" });
    await expect(readFile(join(f.directory, "rejected.dat"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await f.cleanup();
  }
});

test("timed-out file opens release channels even when the ready response never reaches the client", async () => {
  const f = await setup();
  try {
    await promisify(execFile)("git", ["init", f.directory]);
    await writeFile(join(f.directory, "source.dat"), Buffer.alloc(10, 7));
    const { client, faults, scheduler } = f.make();
    await ready(client);
    faults.incoming = (message, frame, deliver) => {
      if (message.type !== "files.ready") deliver(frame);
    };
    for (let index = 0; index < 6; index++) {
      const requestId = `opening-${index}`;
      const download = client.downloadFile(
        { threadId: f.thread.id, op: "download", path: "source.dat", offset: 0 },
        { requestId, timeoutMs: 100 },
      );
      const rejected = expect(download.next()).rejects.toMatchObject({ code: "timeout" });
      await faults.wait(
        (message) => message.type === "files.ready" && message.requestId === requestId,
      );
      scheduler.advance(100);
      await rejected;
      await client.request({
        type: "files.request",
        threadId: f.thread.id,
        operation: { op: "stat", path: "source.dat" },
      });
    }
    faults.incoming = (_message, frame, deliver) => deliver(frame);
    const chunks: Uint8Array[] = [];
    for await (const chunk of client.downloadFile({
      threadId: f.thread.id,
      op: "download",
      path: "source.dat",
      offset: 0,
    }))
      chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(Buffer.alloc(10, 7));
  } finally {
    await f.cleanup();
  }
});

test("upload sources wait for a durable acknowledgement before producing the next binary chunk", async () => {
  const f = await setup();
  try {
    await promisify(execFile)("git", ["init", f.directory]);
    const { client, faults } = f.make();
    await ready(client);
    let produced = 0;
    let release = noop;
    faults.incoming = (message, frame, deliver) => {
      if (message.type === "files.upload" && message.offset === 65536)
        release = () => deliver(frame);
      else deliver(frame);
    };
    const bytes = Buffer.alloc(140000, 255);
    async function* chunks() {
      for await (const chunk of source(bytes)) {
        produced++;
        yield chunk;
      }
    }
    const upload = client.uploadFile(
      {
        threadId: f.thread.id,
        path: "bounded.dat",
        expected: null,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      chunks(),
    );
    await faults.wait((message) => message.type === "files.upload" && message.offset === 65536);
    expect(produced).toBe(1);
    release();
    await upload;
    expect(produced).toBe(3);
    expect(await readFile(join(f.directory, "bounded.dat"))).toEqual(bytes);
  } finally {
    await f.cleanup();
  }
});
function noop() {}
