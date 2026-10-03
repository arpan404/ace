import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, expect, it } from "vitest";
import { DeviceId } from "@ace/protocol";
import { connectClientViaRelay, connectHostToRelay, startRelay } from "@ace/relay";
import { fingerprint, keyPair } from "@ace/secure-channel";
import { attachFilesRelay, CHUNK_SIZE, decodeFileFrame, encodeFileFrame } from "./index.ts";
import { fixture } from "./test-support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
const Ready = z.object({
  type: z.literal("files.ready"),
  channel: z.number(),
  validator: z.string(),
});
const Upload = z.object({
  type: z.literal("files.upload"),
  channel: z.number(),
  uploadId: z.string(),
  offset: z.number(),
});
async function setup() {
  const f = await fixture();
  cleanup.push(() => f.close());
  const relay = await startRelay();
  cleanup.push(() => relay.close());
  const keys = keyPair();
  const host = await connectHostToRelay({
    relayUrl: relay.url,
    hostKeys: keys,
    async onClientChannel(channel) {
      const hello = await channel.receive();
      if (
        hello.type !== "hello" ||
        hello.token !== "device-credential" ||
        !["writer", "readonly"].includes(hello.deviceId)
      ) {
        channel.close();
        return;
      }
      channel.authorize();
      const session = attachFilesRelay(
        f.service,
        channel,
        hello.deviceId,
        (capability) => hello.deviceId !== "readonly" || capability === "files.read",
      );
      try {
        for await (const frame of channel.frames()) {
          if (frame instanceof Uint8Array)
            session.binary(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
          else session.accept(frame);
        }
      } finally {
        session.close();
      }
    },
  });
  cleanup.push(() => host.close());
  const connect = async (device = "writer") => {
    const client = await connectClientViaRelay({
      relayUrl: relay.url,
      hostId: host.hostId,
      pinnedFingerprint: fingerprint(keys.publicKey),
    });
    cleanup.push(async () => {
      client.close();
      await client.closed;
    });
    await client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse(device),
      token: "device-credential",
    });
    return client;
  };
  return { ...f, connectRelay: connect };
}
it("downloads, resumes and uploads exact binary bytes through the end-to-end encrypted relay", async () => {
  const f = await setup();
  const bytes = Buffer.alloc(3 * CHUNK_SIZE);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  await writeFile(join(f.root, "binary"), bytes);
  const first = await f.connectRelay();
  await first.send({
    type: "files.request",
    requestId: "r",
    operation: { op: "download", path: "binary", offset: 0 },
  });
  const ready = Ready.parse(await first.receive());
  await first.send({ type: "files.credit", channel: ready.channel, credits: 1 });
  const initial = z.instanceof(Uint8Array).parse(await first.receiveFrame());
  const prefix = decodeFileFrame(Buffer.from(initial)).bytes;
  expect(prefix).toEqual(bytes.subarray(0, CHUNK_SIZE));
  first.close();
  await first.closed;
  const client = await f.connectRelay();
  await client.send({
    type: "files.request",
    requestId: "r",
    operation: { op: "download", path: "binary", offset: CHUNK_SIZE, validator: ready.validator },
  });
  const resumed = Ready.parse(await client.receive());
  const received: Buffer[] = [prefix];
  for (let offset = CHUNK_SIZE; offset < bytes.length; offset += CHUNK_SIZE) {
    await client.send({ type: "files.credit", channel: resumed.channel, credits: 1 });
    const binary = z.instanceof(Uint8Array).parse(await client.receiveFrame());
    const frame = decodeFileFrame(Buffer.from(binary));
    expect(frame.offset).toBe(offset);
    received.push(frame.bytes);
  }
  expect(await client.receive()).toMatchObject({
    type: "files.end",
    sha256: createHash("sha256").update(bytes.subarray(CHUNK_SIZE)).digest("hex"),
  });
  expect(Buffer.concat(received)).toEqual(bytes);
  await client.send({
    type: "files.request",
    requestId: "r",
    operation: { op: "upload.begin", path: "uploaded", expected: null, size: bytes.length },
  });
  const upload = Upload.parse(await client.receive());
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    await client.sendBinary(
      encodeFileFrame(upload.channel, offset, bytes.subarray(offset, offset + CHUNK_SIZE)),
    );
    expect(await client.receive()).toMatchObject({
      type: "files.upload",
      offset: offset + CHUNK_SIZE,
    });
  }
  await client.send({
    type: "files.request",
    requestId: "r",
    operation: {
      op: "upload.commit",
      uploadId: upload.uploadId,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  });
  expect(await client.receive()).toMatchObject({ type: "files.changed", change: { op: "upload" } });
  expect(await client.receive()).toMatchObject({ type: "files.result" });
  expect(await readFile(join(f.root, "uploaded"))).toEqual(bytes);
}, 60_000);

it("keeps a read-only relay device from mutating the workspace", async () => {
  const f = await setup();
  const client = await f.connectRelay("readonly");
  await client.send({
    type: "files.request",
    requestId: "r",
    operation: { op: "create", path: "bad", expected: null, text: "bad" },
  });
  expect(await client.receive()).toMatchObject({ type: "files.error", code: "FORBIDDEN" });
  await expect(readFile(join(f.root, "bad"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("rejects oversized binary sends without closing a usable encrypted channel", async () => {
  const f = await setup();
  const client = await f.connectRelay();
  await expect(client.sendBinary(new Uint8Array(CHUNK_SIZE + 17))).rejects.toThrow(
    "Binary message too large",
  );
  await client.send({
    type: "files.request",
    requestId: "r",
    operation: { op: "stat", path: "missing" },
  });
  expect(await client.receive()).toMatchObject({ type: "files.result", value: { version: null } });
});
