import { afterEach, expect, test } from "vitest";
import { facts, fixtureImage } from "@ace/fake-daemon";
import { ThreadId, ItemId } from "@ace/protocol";
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
      { ...request, threadId: ThreadId.parse("foreign") },
      new AbortController().signal,
    ),
  ).rejects.toThrow("Media unavailable");
  lease.release();
});
