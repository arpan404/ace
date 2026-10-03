import { once } from "node:events";
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { expect, it } from "vitest";
import { attachFilesSocket, encodeFileFrame } from "./index.ts";
import { Client, fixture } from "./test-support.ts";

it("shares the binary upload channel with a destination-owned blob writer", async () => {
  const f = await fixture();
  const path = join(f.home, "blob");
  const file = await open(path, "wx");
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: 1024 * 1024 });
  let client: Client | undefined;
  try {
    wss.on("connection", (socket) => {
      const session = attachFilesSocket(f.service, socket, "writer");
      const upload = session.bindUpload({
        uploadId: "attachment",
        offset: 0,
        size: 3,
        async append(offset, bytes, assertAuthorized) {
          assertAuthorized();
          await file.write(bytes, 0, bytes.length, offset);
          await file.sync();
          return { uploadId: "attachment", offset: offset + bytes.length, size: 3 };
        },
      });
      socket.send(JSON.stringify({ type: "files.upload", ...upload }));
      socket.on("message", (data, binary) => {
        if (binary) session.binary(z.instanceof(Buffer).parse(data));
        else session.accept(JSON.parse(data.toString()));
      });
    });
    await once(wss, "listening");
    const address = wss.address();
    if (!address || typeof address === "string") throw new Error("No listener");
    client = new Client(`ws://127.0.0.1:${address.port}`);
    await once(client.socket, "open");
    const upload = z.object({ channel: z.number() }).parse(await client.next());
    client.socket.send(encodeFileFrame(upload.channel, 1, Buffer.from("a")));
    expect(await client.next()).toMatchObject({ code: "OFFSET" });
    expect(await readFile(path)).toEqual(Buffer.alloc(0));
    client.socket.send(encodeFileFrame(upload.channel, 0, Buffer.from("abc")));
    expect(await client.next()).toMatchObject({
      type: "files.upload",
      uploadId: "attachment",
      offset: 3,
    });
    expect(await readFile(path, "utf8")).toBe("abc");
  } finally {
    await client?.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await file.close();
    await f.close();
  }
});
