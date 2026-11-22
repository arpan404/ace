import { createHash } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { connect, fixture, reset, until } from "./thread-harness.ts";
import { AttachmentTray, type ChunkReader, type TrayRow } from "./thread-attachments.ts";

/*
 * How a file's upload progress reaches the phone: over the real SDK and the fake daemon's upload
 * service, with the clock in the test's hands. Progress is drawn as a line on the file's chip,
 * so it must arrive often enough to move and never so often that Swift redraws on every chunk.
 */

afterEach(reset);

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function client() {
  const fake = fixture();
  fake.createThread({ id: "files", workspaceId: "ace", title: "Files", provider: "codex" });
  fake.apply("files", [facts.rootAgent("codex"), facts.turn("root"), facts.endTurn("root")]);
  const owner = connect(fake);
  await until(() => owner.connectionState().getSnapshot() === "ready", "the connection");
  return owner;
}

/** A tray whose clock moves `step` milliseconds each time a chunk is read. */
async function tray(bytes: Buffer, step: number) {
  let now = 0;
  const read: ChunkReader = async (_id, offset, limit) => {
    now += step;
    return bytes.subarray(offset, offset + limit).toString("base64");
  };
  const emits: TrayRow[][] = [];
  const box = new AttachmentTray(
    await client(),
    { threadId: ThreadId.parse("files") },
    new AbortController().signal,
    (rows) => emits.push(rows),
    read,
    () => now,
  );
  box.attach({
    localId: "video-0001",
    name: "clip.mov",
    mimeType: "video/quicktime",
    bytes: bytes.length,
    sha256: sha(bytes),
  });
  const progress = () =>
    emits
      .map((rows) => rows[0])
      .filter((row) => row?.state === "uploading" && Number(row.progress) > 0)
      .map((row) => Number(row?.progress));
  const done = () => emits.at(-1)?.[0]?.state === "ready";
  return { progress, done };
}

test("fast chunks reach the phone at most about ten times a second", async () => {
  // 19 chunks of 48 KiB, read 10 ms apart: under 200 ms of uploading.
  const upload = await tray(Buffer.alloc(900 * 1024, 4), 10);
  await until(upload.done, "the upload");
  expect(upload.progress().length).toBeGreaterThan(0);
  expect(upload.progress().length).toBeLessThanOrEqual(3);
  // What does arrive still climbs, and never claims done before the commit.
  const shown = upload.progress();
  expect(shown).toEqual(shown.toSorted((a, b) => a - b));
  expect(Math.max(...shown)).toBeLessThan(1);
});

test("slow chunks each move the line", async () => {
  // 150 ms a chunk: every acknowledged chunk is shown.
  const upload = await tray(Buffer.alloc(192 * 1024, 4), 150);
  await until(upload.done, "the upload");
  expect(upload.progress()).toHaveLength(4);
});
