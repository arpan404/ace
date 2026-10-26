import { createHash } from "node:crypto";
import { facts, fixtureImage, type FakeDaemon } from "@ace/fake-daemon";
import { ItemId, ThreadId, type Attachment, type ContentPart } from "@ace/protocol";
import { afterEach, expect, test } from "vitest";
import { readNativeAttachment } from "./native-attachment.ts";
import { connect, fixture, open, reset, rows, until } from "./thread-harness.ts";

/*
 * A person's message sent from another device, as the phone shows it: its images as thumbnails
 * the phone reads through the thread's own connection, its files as rows that open. Only what
 * the message carries can be read, and only in its own thread. No provider CLI runs.
 */

afterEach(reset);

const png = Buffer.from(fixtureImage.data, "base64");
const notes = "Route table\n/ -> home\n";
const notesSha = createHash("sha256").update(notes).digest("hex");
const secret = "not on the message";
const secretSha = createHash("sha256").update(secret).digest("hex");

const image: Attachment = {
  sha256: fixtureImage.sha256,
  bytes: png.length,
  mimeType: "image/png",
  name: "screen.png",
  kind: "image",
  width: 640,
  height: 480,
  thumbnailAvailable: true,
};
const file: Attachment = {
  sha256: notesSha,
  bytes: Buffer.byteLength(notes),
  mimeType: "text/plain",
  name: "routes.txt",
  kind: "text",
};

function sentFromWeb(threadId: string, parts: ContentPart[], attachments: Attachment[] = []) {
  const fake = fixture();
  fake.createThread({ id: threadId, workspaceId: "ace", title: "Photos", provider: "codex" });
  fake.createThread({ id: "elsewhere", workspaceId: "ace", title: "Other", provider: "codex" });
  fake.apply(threadId, [
    facts.rootAgent("codex"),
    {
      type: "item.upsert",
      agent: "root",
      item: "ask",
      draft: { type: "message", role: "user", complete: true, parts, attachments },
    },
  ]);
  fake.seedServices({
    attachmentImages: [{ threadId, name: "screen.png" }],
    attachmentTexts: [
      { threadId, sha256: notesSha, text: notes, name: "routes.txt" },
      { threadId, sha256: secretSha, text: secret, name: "secret.txt" },
    ],
  });
  return fake;
}

async function personsRow(fake: FakeDaemon, threadId: string) {
  const owner = connect(fake);
  open(owner, threadId);
  const row = await until(
    () => rows("thread.item").find((item) => item.role === "user"),
    "the person's message",
  );
  return { owner, row, itemId: ItemId.parse(String(row.id)) };
}

const read = (
  owner: Parameters<typeof readNativeAttachment>[0],
  request: { threadId: string; itemId: ItemId; ref: string; variant: "thumbnail" | "original" },
) =>
  readNativeAttachment(
    owner,
    { type: "native.attachment", ...request, threadId: ThreadId.parse(request.threadId) },
    new AbortController().signal,
  );

test("a web-sent image appears in the person's row as a thumbnail the phone can read", async () => {
  const { owner, row, itemId } = await personsRow(
    sentFromWeb("photos", [{ type: "text", text: "What is on screen?" }], [image, file]),
    "photos",
  );
  expect(row.attachments).toEqual([
    {
      kind: "image",
      name: "screen.png",
      ref: fixtureImage.sha256,
      mimeType: "image/png",
      bytes: png.length,
      width: 640,
      height: 480,
      thumbnail: true,
      opens: true,
    },
    {
      kind: "text",
      name: "routes.txt",
      ref: notesSha,
      mimeType: "text/plain",
      bytes: Buffer.byteLength(notes),
      width: 0,
      height: 0,
      thumbnail: false,
      opens: true,
    },
  ]);

  const thumbnail = await read(owner, {
    threadId: "photos",
    itemId,
    ref: fixtureImage.sha256,
    variant: "thumbnail",
  });
  expect(thumbnail).toMatchObject({ kind: "image", name: "screen.png", mimeType: "image/png" });
  // A PNG the phone can decode.
  expect(Buffer.from(thumbnail.data, "base64").subarray(1, 4).toString()).toBe("PNG");
});

test("a message's file opens with its own bytes, and a file without a preview is never fetched to draw a row", async () => {
  const { owner, itemId } = await personsRow(
    sentFromWeb("files", [{ type: "text", text: "Read this" }], [file]),
    "files",
  );
  const opened = await read(owner, {
    threadId: "files",
    itemId,
    ref: notesSha,
    variant: "original",
  });
  expect(opened).toMatchObject({ kind: "file", name: "routes.txt" });
  expect(Buffer.from(opened.data, "base64").toString()).toBe(notes);
  await expect(
    read(owner, { threadId: "files", itemId, ref: notesSha, variant: "thumbnail" }),
  ).rejects.toThrow("No preview");
});

test("only files the message itself carries, in its own thread, can be read", async () => {
  const { owner, itemId } = await personsRow(
    sentFromWeb("guarded", [{ type: "text", text: "Look" }], [image]),
    "guarded",
  );
  // Held by the same thread, but not part of this message.
  await expect(
    read(owner, { threadId: "guarded", itemId, ref: secretSha, variant: "original" }),
  ).rejects.toThrow("Attachment unavailable");
  // The same message asked for through another thread.
  await expect(
    read(owner, { threadId: "elsewhere", itemId, ref: fixtureImage.sha256, variant: "thumbnail" }),
  ).rejects.toThrow("Attachment unavailable");
});

test("an inline image in the message shows from its own data; a linked one is never fetched", async () => {
  const { owner, row, itemId } = await personsRow(
    sentFromWeb("inline", [
      { type: "text", text: "Both of these" },
      { type: "image", mimeType: "image/png", url: `data:image/png;base64,${fixtureImage.data}` },
      { type: "image", mimeType: "image/png", url: "https://example.com/elsewhere.png" },
    ]),
    "inline",
  );
  expect(row.attachments).toMatchObject([
    { kind: "image", ref: "part:1", thumbnail: true, opens: true },
    { kind: "image", ref: "", thumbnail: false, opens: false },
  ]);
  const shown = await read(owner, {
    threadId: "inline",
    itemId,
    ref: "part:1",
    variant: "original",
  });
  expect(shown).toMatchObject({ kind: "image", mimeType: "image/png", data: fixtureImage.data });
  await expect(
    read(owner, { threadId: "inline", itemId, ref: "part:2", variant: "original" }),
  ).rejects.toThrow("Attachment unavailable");
});
