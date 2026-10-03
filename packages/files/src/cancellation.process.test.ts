import { once } from "node:events";
import { open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { expect, it } from "vitest";
import { attachFilesSocket, createExclusiveRename, encodeFileFrame } from "./index.ts";
import { Client, fixture } from "./test-support.ts";

function barrier() {
  let resolve: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve() };
}
async function socketFixture(
  f: Awaited<ReturnType<typeof fixture>>,
  attach: (session: ReturnType<typeof attachFilesSocket>) => unknown,
) {
  const cancelled = barrier();
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  wss.on("connection", (socket) => {
    const session = attachFilesSocket(f.service, socket, "writer");
    const initial = attach(session);
    if (initial)
      socket.send(
        JSON.stringify({
          type: "files.upload",
          ...z
            .object({
              channel: z.number(),
              uploadId: z.string(),
              offset: z.number(),
              size: z.number(),
            })
            .parse(initial),
        }),
      );
    socket.on("message", (raw, binary) => {
      if (binary) session.binary(z.instanceof(Buffer).parse(raw));
      else {
        const input: unknown = JSON.parse(raw.toString());
        session.accept(input);
        if (z.object({ type: z.literal("files.cancel") }).safeParse(input).success)
          cancelled.resolve();
      }
    });
  });
  await once(wss, "listening");
  const address = wss.address();
  if (!address || typeof address === "string") throw new Error("No socket address");
  const client = new Client(`ws://127.0.0.1:${address.port}`);
  await once(client.socket, "open");
  return {
    client,
    cancelled,
    async close() {
      await client.close();
      await new Promise<void>((done) => wss.close(() => done()));
    },
  };
}
const Upload = z.object({ channel: z.number(), uploadId: z.string() });

it("cancels a workspace append queued behind another mutation before it can write", async () => {
  const entered = barrier();
  const resume = barrier();
  const native = createExclusiveRename();
  const f = await fixture({
    maxTransfers: 1,
    exclusiveRename: {
      async move(source, destination) {
        entered.resolve();
        await resume.promise;
        await native.move(source, destination);
      },
      close: () => native.close(),
    },
  });
  const sockets = await socketFixture(f, () => undefined);
  try {
    await writeFile(join(f.root, "existing"), "data");
    const upload = Upload.parse(
      await sockets.client.request({ op: "upload.begin", path: "result", expected: null, size: 3 }),
    );
    const blocker = f.service.request("writer", {
      op: "create",
      path: "blocking",
      expected: null,
      text: "blocking",
    });
    await entered.promise;
    sockets.client.socket.send(encodeFileFrame(upload.channel, 0, Buffer.from("abc")));
    sockets.client.send({ type: "files.cancel", channel: upload.channel });
    await sockets.cancelled.promise;
    // This read replies while the append is still blocked. Cancellation must not reply first.
    expect(await sockets.client.request({ op: "stat", path: "existing" })).toMatchObject({
      type: "files.result",
    });
    await expect(
      f.service.download("writer", { op: "download", path: "existing" }),
    ).rejects.toMatchObject({ code: "BUSY" });
    resume.resolve();
    await blocker;
    expect(await sockets.client.next()).toMatchObject({
      type: "files.changed",
      change: { path: "blocking" },
    });
    expect(await sockets.client.next()).toMatchObject({ type: "files.cancelled" });
    expect(
      await sockets.client.request({ op: "upload.resume", uploadId: upload.uploadId }),
    ).toMatchObject({ type: "files.upload", offset: 0 });
    expect(await readFile(join(f.root, `.ace-upload-${upload.uploadId}`))).toEqual(Buffer.alloc(0));
  } finally {
    resume.resolve();
    await sockets.close();
    await f.close();
  }
});

for (const started of [false, true]) {
  it(`drains a ${started ? "started" : "queued"} destination-owned append before acknowledging cancellation`, async () => {
    const f = await fixture({ maxTransfers: 1 });
    const file = await open(join(f.home, "blob"), "wx");
    const entered = barrier();
    const resume = barrier();
    const sockets = await socketFixture(f, (session) =>
      session.bindUpload({
        uploadId: "attachment",
        offset: 0,
        size: 3,
        async append(offset, bytes, assertActive) {
          if (started) assertActive();
          entered.resolve();
          await resume.promise;
          if (!started) assertActive();
          await file.write(bytes, 0, bytes.length, offset);
          await file.sync();
          return { uploadId: "attachment", offset: 3, size: 3 };
        },
      }),
    );
    try {
      await writeFile(join(f.root, "existing"), "data");
      const upload = Upload.parse(await sockets.client.next());
      sockets.client.socket.send(encodeFileFrame(upload.channel, 0, Buffer.from("abc")));
      await entered.promise;
      sockets.client.send({ type: "files.cancel", channel: upload.channel });
      await sockets.cancelled.promise;
      expect(await sockets.client.request({ op: "stat", path: "existing" })).toMatchObject({
        type: "files.result",
      });
      await expect(
        f.service.download("writer", { op: "download", path: "existing" }),
      ).rejects.toMatchObject({ code: "BUSY" });
      resume.resolve();
      expect(await sockets.client.next()).toMatchObject({ type: "files.cancelled" });
      // A following roundtrip detects any upload acknowledgement emitted after cancellation.
      expect(await sockets.client.request({ op: "stat", path: "existing" })).toMatchObject({
        type: "files.result",
      });
      expect(await readFile(join(f.home, "blob"), "utf8")).toBe(started ? "abc" : "");
    } finally {
      resume.resolve();
      await sockets.close();
      await file.close();
      await f.close();
    }
  });
}
