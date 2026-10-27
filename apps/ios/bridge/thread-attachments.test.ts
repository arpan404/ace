import { createHash } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";
import {
  commands,
  connect,
  fixture,
  latest,
  open,
  pump,
  reset,
  sent,
  until,
} from "./thread-harness.ts";
import { ThreadSession } from "./thread-session.ts";
import type { ChunkReader } from "./thread-attachments.ts";

/*
 * Photos and files on the phone's next message, over the real SDK and the fake daemon's upload
 * service: Swift's staged bytes are pulled a chunk at a time, the message carries what the
 * daemon holds, and a file over the shared limit is refused before anything uploads. No
 * provider CLI runs.
 */

afterEach(reset);

type Tray = { files: { id: string; state: string; progress: number; error: string }[] };
const tray = () => latest("thread.attachments") as Tray | undefined;
const staged = new Map<string, Buffer>();
const reads: { offset: number; limit: number }[] = [];
const chunks: ChunkReader = async (localId, offset, limit) => {
  reads.push({ offset, limit });
  return (staged.get(localId) ?? Buffer.alloc(0))
    .subarray(offset, offset + limit)
    .toString("base64");
};
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function idle() {
  const fake = fixture();
  fake.createThread({ id: "files", workspaceId: "ace", title: "Files", provider: "codex" });
  fake.apply("files", [facts.rootAgent("codex"), facts.turn("root"), facts.endTurn("root")]);
  return fake;
}
const uploads = (op: string) =>
  sent.filter((text) => text.includes('"context.request"') && text.includes(`"op":"${op}"`));

test("a photo uploads in chunks and the next message carries it", async () => {
  const photo = Buffer.alloc(120 * 1024, 7);
  staged.set("photo-0001", photo);
  reads.length = 0;
  const thread = open(connect(idle()), "files", chunks);
  await until(() => latest("thread.controls"), "the composer");
  thread.handle({
    type: "attach",
    file: {
      localId: "photo-0001",
      name: "screen.png",
      mimeType: "image/png",
      bytes: photo.length,
      sha256: sha(photo),
    },
  });
  thread.handle({ type: "send", text: "Too soon", opposite: false, requestId: "early" });
  await until(() => latest("admission", "early"), "the early send refused");
  expect(latest("admission", "early")).toMatchObject({ ok: false });
  await until(() => tray()?.files[0]?.state === "ready", "the upload");
  expect(reads.map((read) => read.offset)).toEqual([0, 48 * 1024, 96 * 1024]);
  expect(Math.max(...reads.map((read) => read.limit))).toBeLessThanOrEqual(48 * 1024);
  thread.handle({ type: "send", text: "What is on screen?", opposite: false, requestId: "m1" });
  await until(() => commands("thread.send").length === 1, "the message");
  expect(commands("thread.send")[0]?.context).toMatchObject({
    attachments: [{ sha256: sha(photo) }],
  });
  await until(() => tray()?.files.length === 0, "the tray emptied");
});

test("a video uploads to an agent with known capabilities and goes with the message", async () => {
  // Every file type reaches the agent (natively, inline or as a readable path), so a provider
  // that reads images doesn't refuse a clip for not being one.
  const fake = fixture();
  fake.createThread({
    id: "clips",
    workspaceId: "ace",
    title: "Clips",
    provider: "codex",
    capabilities: { imageInput: true },
  });
  fake.apply("clips", [facts.rootAgent("codex"), facts.turn("root"), facts.endTurn("root")]);
  const clip = Buffer.alloc(64 * 1024, 3);
  staged.set("clip-0001", clip);
  const thread = open(connect(fake), "clips", chunks);
  await until(() => latest("thread.controls"), "the composer");
  thread.handle({
    type: "attach",
    file: {
      localId: "clip-0001",
      name: "Clip.mov",
      mimeType: "video/quicktime",
      bytes: clip.length,
      sha256: sha(clip),
    },
  });
  await until(() => tray()?.files[0]?.state === "ready", "the upload");
  expect(tray()?.files[0]).toMatchObject({ kind: "video", mimeType: "video/quicktime", error: "" });
  thread.handle({ type: "send", text: "What happens here?", opposite: false, requestId: "m1" });
  await until(() => commands("thread.send").length === 1, "the message");
  expect(commands("thread.send")[0]?.context).toMatchObject({
    attachments: [{ sha256: sha(clip) }],
  });
});

test("a file over the shared size limit is refused before anything uploads", async () => {
  const thread = open(connect(idle()), "files", chunks);
  await until(() => latest("thread.controls"), "the composer");
  thread.handle({
    type: "attach",
    file: {
      localId: "video-0001",
      name: "screen.mov",
      mimeType: "video/quicktime",
      bytes: 600 * 1024 * 1024,
      sha256: "a".repeat(64),
    },
  });
  const file = await until(() => tray()?.files[0], "the refused file");
  expect(file).toMatchObject({
    state: "failed",
    error: "Too large: files can be up to 512 MB each",
  });
  expect(uploads("upload.begin")).toHaveLength(0);
  // Request ids of its own: the sink keeps earlier tests' answers.
  thread.handle({ type: "send", text: "Here", opposite: false, requestId: "too-large-send" });
  await until(() => latest("admission", "too-large-send"), "the send refused");
  expect(latest("admission", "too-large-send")?.ok).toBe(false);
  thread.handle({ type: "detach", localId: "video-0001" });
  await until(() => tray()?.files.length === 0, "the file removed");
  thread.handle({ type: "send", text: "Here", opposite: false, requestId: "too-large-retry" });
  await until(() => latest("admission", "too-large-retry")?.ok, "the send admitted");
  expect(commands("thread.send")[0]?.context).toBeUndefined();
});

test("removing a file mid-upload cancels it on the daemon", async () => {
  const big = Buffer.alloc(900 * 1024, 3);
  staged.set("doc-0001", big);
  let release: (() => void) | undefined;
  const slow: ChunkReader = async (localId, offset, limit) => {
    if (offset > 0) await new Promise<void>((resolve) => (release = resolve));
    return chunks(localId, offset, limit);
  };
  const thread = open(connect(idle()), "files", slow);
  await until(() => latest("thread.controls"), "the composer");
  thread.handle({
    type: "attach",
    file: {
      localId: "doc-0001",
      name: "notes.png",
      mimeType: "image/png",
      bytes: big.length,
      sha256: sha(big),
    },
  });
  await until(() => (tray()?.files[0]?.progress ?? 0) > 0, "upload progress");
  thread.handle({ type: "detach", localId: "doc-0001" });
  release?.();
  await until(() => uploads("upload.cancel").length === 1, "the cancel");
  await until(() => tray()?.files.length === 0, "the tray emptied");
  expect(uploads("upload.commit")).toHaveLength(0);
});

test("a message of only files goes with empty words, and nothing at all is refused", async () => {
  const photo = Buffer.alloc(10 * 1024, 5);
  staged.set("photo-0002", photo);
  const thread = open(connect(idle()), "files", chunks);
  await until(() => latest("thread.controls"), "the composer");
  thread.handle({ type: "send", text: "  ", opposite: false, requestId: "blank" });
  await until(() => latest("admission", "blank"), "the blank send refused");
  expect(latest("admission", "blank")).toMatchObject({
    ok: false,
    message: "Write a message or attach a file.",
  });
  thread.handle({
    type: "attach",
    file: {
      localId: "photo-0002",
      name: "shot.png",
      mimeType: "image/png",
      bytes: photo.length,
      sha256: sha(photo),
    },
  });
  await until(() => tray()?.files[0]?.state === "ready", "the upload");
  thread.handle({ type: "send", text: "", opposite: false, requestId: "only-files" });
  await until(() => commands("thread.send").length === 1, "the message");
  expect(commands("thread.send")[0]).toMatchObject({
    input: [{ type: "text", text: "" }],
    context: { attachments: [{ sha256: sha(photo) }] },
  });
});

test("a refused upload says what to do in the web's words, not the daemon's code", async () => {
  const big = Buffer.alloc(2 * 1024 * 1024, 1);
  staged.set("big-00001", big);
  const thread = open(connect(idle()), "files", chunks);
  await until(() => latest("thread.controls"), "the composer");
  thread.handle({
    type: "attach",
    file: {
      localId: "big-00001",
      name: "large.png",
      mimeType: "image/png",
      bytes: big.length,
      sha256: sha(big),
    },
  });
  const file = await until(
    () => (tray()?.files[0]?.state === "failed" ? tray()?.files[0] : undefined),
    "the refusal",
  );
  expect(file?.error).toBe(
    "Attachment limit reached. Open Attachments from the thread menu and remove files you no longer need.",
  );
});

test("a file still uploading when the thread is read again from its machine stays on the message", async () => {
  const photo = Buffer.alloc(120 * 1024, 9);
  staged.set("photo-0002", photo);
  // The second chunk waits until the transcript has been read again.
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const slow: ChunkReader = async (localId, offset, limit) => {
    if (offset > 0) await gate;
    return chunks(localId, offset, limit);
  };
  const client = connect(idle());
  const first = open(client, "files", slow);
  await until(() => latest("thread.controls"), "the composer");
  first.handle({
    type: "attach",
    file: {
      localId: "photo-0002",
      name: "screen.png",
      mimeType: "image/png",
      bytes: photo.length,
      sha256: sha(photo),
    },
  });
  await until(() => tray()?.files[0]?.state === "uploading", "the upload under way");

  // Reload from machine: this session goes and a new one shows the thread.
  const kept = first.keepTray();
  first.dispose();
  const lease = client.thread("files");
  const second = new ThreadSession(client, lease.store, "files", 2, pump, slow, undefined, kept);
  release();
  await until(() => tray()?.files[0]?.state === "ready", "the upload finished");
  second.handle({ type: "send", text: "And now?", opposite: false, requestId: "m2" });
  await until(() => commands("thread.send").length === 1, "the message");
  expect(commands("thread.send")[0]?.context).toMatchObject({
    attachments: [{ sha256: sha(photo) }],
  });
  second.dispose();
  lease.release();
});
