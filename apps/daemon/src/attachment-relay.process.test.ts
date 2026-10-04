import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { attachmentBytes } from "@ace/client";
import { ContextService } from "@ace/context";
import { ContextResult, DeviceId } from "@ace/protocol";
import { startRelay, connectClientViaRelay } from "@ace/relay";
import { keyPair, fingerprint } from "@ace/secure-channel";
import { Store } from "./store.ts";
import { createDevThread } from "./commands.ts";
import { RemoteAuth } from "./remote-auth.ts";
import { startFilesRelay } from "./files-relay.ts";

test("paired relay readers resolve exact attachment bytes and previews while other scopes, threads and revocation are refused", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-image-relay-"));
  const cleanup: (() => Promise<void> | void)[] = [
    () => rm(home, { recursive: true, force: true }),
  ];
  try {
    const store = new Store(join(home, "store.sqlite"));
    cleanup.push(() => store.close());
    const thread = createDevThread(store, store.createWorkspace(home, "Images"));
    let counter = 0,
      allowed = true;
    const context = await ContextService.open({
      root: join(home, "context"),
      now: () => 1000,
      id: () => `upload-${++counter}`,
      authorize: (_device, id) => id === thread.id,
      workspace: () => undefined,
    });
    cleanup.push(() => context.close());
    const bytes = await readFile(
        new URL("../../../packages/context/fixtures/colours.png", import.meta.url),
      ),
      sha256 = createHash("sha256").update(bytes).digest("hex");
    const begin = await context.uploads.handle("owner", {
      op: "upload.begin",
      threadId: thread.id,
      name: "photo.png",
      bytes: bytes.length,
      sha256,
    });
    if (begin.kind !== "upload") throw new Error("Expected upload");
    for (let offset = 0; offset < bytes.length; offset += 65531)
      await context.uploads.handle("owner", {
        op: "upload.chunk",
        uploadId: begin.uploadId,
        offset,
        data: bytes.subarray(offset, offset + 65531).toString("base64"),
      });
    await context.uploads.handle("owner", { op: "upload.commit", uploadId: begin.uploadId });
    const auth = new RemoteAuth(store.devices, "a".repeat(64), {
      now: () => 1000,
      secret: randomUUID,
    });
    const reader = auth.redeem(auth.pairing(["read"]).code, "Reader"),
      operator = auth.redeem(auth.pairing(["operate"]).code, "Operator");
    const relay = await startRelay();
    cleanup.push(() => relay.close());
    const keys = keyPair();
    const host = await startFilesRelay({
      url: relay.url,
      keys,
      auth,
      devices: store.devices,
      context,
      store,
      canReadThread: (_device, id) => allowed && id === thread.id,
      hostId: "attachment-host",
      headSeq: () => 0,
    });
    cleanup.push(() => host.close());
    async function connect(device: typeof reader) {
      const channel = await connectClientViaRelay({
        relayUrl: relay.url,
        hostId: host.hostId,
        pinnedFingerprint: fingerprint(keys.publicKey),
      });
      cleanup.push(async () => {
        channel.close();
        await channel.closed;
      });
      await channel.send({
        type: "hello",
        protocolVersion: 1,
        deviceId: device.device.id,
        token: device.token,
        channel: "files",
      });
      expect(await channel.receive()).toMatchObject({ type: "welcome" });
      let request = 0;
      return {
        channel,
        connection: {
          async request(input: Parameters<Parameters<typeof attachmentBytes>[0]["request"]>[0]) {
            await channel.send({ ...input, requestId: `read-${++request}` });
            return ContextResult.parse(await channel.receive());
          },
        },
      };
    }
    const r = await connect(reader);
    const original = await attachmentBytes(r.connection, {
      threadId: thread.id,
      sha256,
      variant: "original",
      maxBytes: bytes.length,
    });
    expect(Buffer.from(original.bytes)).toEqual(bytes);
    const preview = await attachmentBytes(r.connection, { threadId: thread.id, sha256 });
    expect(preview.bytes.length).toBeLessThan(256 * 1024);
    expect(preview.mimeType).toBe("image/png");
    await expect(
      attachmentBytes(r.connection, { threadId: "other-thread", sha256 }),
    ).rejects.toThrow("permission");
    const o = await connect(operator);
    await expect(attachmentBytes(o.connection, { threadId: thread.id, sha256 })).rejects.toThrow(
      "permission",
    );
    allowed = false;
    await expect(attachmentBytes(r.connection, { threadId: thread.id, sha256 })).rejects.toThrow(
      "permission",
    );
    allowed = true;
    expect(auth.revoke(DeviceId.parse(reader.device.id))).toBe(true);
    await r.channel.closed;
  } finally {
    for (const close of cleanup.toReversed()) await close();
  }
});
