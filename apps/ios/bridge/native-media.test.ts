import { afterEach, expect, test } from "vitest";
import { facts, fixtureImage } from "@ace/fake-daemon";
import { DeviceId, ThreadId, ItemId } from "@ace/protocol";
import { Client, ClientError } from "@ace/client";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { createHash } from "node:crypto";
import { readNativeMedia } from "./native-media.ts";
import { sheetFixture, until } from "./sheet-fixture.ts";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
});

test("published images read their own authenticated attachment and cannot be fetched by a foreign thread", async () => {
  const { daemon, client } = sheetFixture();
  close = () => client.close();
  const threadId = ThreadId.parse("picture");
  daemon.createThread({ id: threadId, workspaceId: "ace", provider: "codex", title: "Picture" });
  const foreignThreadId = ThreadId.parse("foreign");
  daemon.createThread({
    id: foreignThreadId,
    workspaceId: "ace",
    provider: "codex",
    title: "Other",
  });
  daemon.apply(threadId, [
    facts.rootAgent("codex"),
    {
      type: "item.upsert",
      agent: "root",
      item: "image",
      draft: {
        type: "image",
        complete: true,
        image: {
          alt: "Example",
          attachment: {
            sha256: fixtureImage.sha256,
            bytes: Buffer.from(fixtureImage.data, "base64").length,
            mimeType: "image/png",
            name: fixtureImage.name,
          },
        },
      },
    },
  ]);
  daemon.seedServices({ attachmentImages: [{ threadId, name: fixtureImage.name }] });
  const lease = client.thread(threadId);
  await client.start();
  await until(
    () => lease.store.order.some((id) => lease.store.item(id)?.type === "image"),
    "image published",
  );
  const imageId = lease.store.order.find((id) => lease.store.item(id)?.type === "image");
  if (!imageId) throw new Error("Published image missing");
  const request = {
    type: "native.media" as const,
    threadId,
    itemId: ItemId.parse(imageId),
    scheme: "light" as const,
  };
  const result = await readNativeMedia(client, request, new AbortController().signal);
  expect(result).toEqual({ kind: "image", data: fixtureImage.data });
  await expect(
    readNativeMedia(
      client,
      { ...request, threadId: foreignThreadId },
      new AbortController().signal,
    ),
  ).rejects.toThrow("Media unavailable");
  lease.release();
});

test("a published canvas still opens on a daemon that has no attachment stream", async () => {
  const daemon = new FakeDaemon({ clock: Date.now });
  const client = new Client({
    deviceId: DeviceId.parse("ios-media-device"),
    transport: () => fakeTransport(daemon),
    credential: async () => daemon.token,
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set(delayMs, callback) {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
      },
    },
    random: () => 0.5,
    id: () => crypto.randomUUID(),
    // Asked for the binary attachment stream, this daemon answers as one that never had it.
    // oxlint-disable-next-line require-yield
    async *attachmentSource() {
      throw new ClientError("daemon", "UNSUPPORTED");
    },
  });
  close = () => client.close();
  const threadId = ThreadId.parse("canvas");
  const html = "<!doctype html><html><head></head><body><p>Step 1</p></body></html>";
  const sha256 = createHash("sha256").update(html).digest("hex");
  daemon.createThread({ id: threadId, workspaceId: "ace", provider: "codex", title: "Canvas" });
  daemon.apply(threadId, [
    facts.rootAgent("codex"),
    {
      type: "item.upsert",
      agent: "root",
      item: "page",
      draft: {
        type: "html",
        complete: true,
        visualization: {
          title: "Counter",
          mode: "interactive",
          document: {
            sha256,
            bytes: Buffer.byteLength(html),
            mimeType: "text/plain",
            name: "c.html",
          },
        },
      },
    },
  ]);
  daemon.seedServices({ attachmentTexts: [{ threadId, sha256, text: html, name: "c.html" }] });
  const lease = client.thread(threadId);
  await client.start();
  await until(
    () => lease.store.order.some((id) => lease.store.item(id)?.type === "html"),
    "canvas",
  );
  const itemId = lease.store.order.find((id) => lease.store.item(id)?.type === "html");
  if (!itemId) throw new Error("Canvas missing");
  const result = await readNativeMedia(
    client,
    { type: "native.media", threadId, itemId: ItemId.parse(itemId), scheme: "light" },
    new AbortController().signal,
  );
  expect(result).toMatchObject({ kind: "html" });
  // The page travels URL-encoded inside the sandboxed wrapper.
  expect(JSON.stringify(result)).toContain("Step%201");
  lease.release();
});
