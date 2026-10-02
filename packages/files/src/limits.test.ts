import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { afterEach, expect, it } from "vitest";
import { encodeFileFrame } from "./index.ts";
import { fixture } from "./test-support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
async function setup(options: Parameters<typeof fixture>[0] = {}) {
  const f = await fixture(options);
  cleanup.push(() => f.close());
  return f;
}
const Version = z.object({ value: z.object({ version: z.string() }) });
const Upload = z.object({ uploadId: z.string(), channel: z.number() });

it("detects a nested agent edit before deleting or moving a directory", async () => {
  const f = await setup();
  const client = await f.connect();
  await mkdir(join(f.root, "dir"));
  await writeFile(join(f.root, "dir", "file"), "old");
  const current = Version.parse(await client.request({ op: "stat", path: "dir" })).value.version;
  await writeFile(join(f.root, "dir", "file"), "agent edit");
  expect(await client.request({ op: "delete", path: "dir", expected: current })).toMatchObject({
    code: "CONFLICT",
  });
  expect(
    await client.request({
      op: "move",
      path: "dir",
      expected: current,
      destination: "newdir",
      destinationExpected: null,
    }),
  ).toMatchObject({ code: "CONFLICT" });
  expect(await readFile(join(f.root, "dir", "file"), "utf8")).toBe("agent edit");
});

it("rejects malformed binary frames and pipelined upload bytes without appending them", async () => {
  const f = await setup();
  const client = await f.connect();
  client.socket.send(Buffer.from("wrong"));
  expect(await client.next()).toMatchObject({ code: "INVALID_FRAME" });
  const upload = Upload.parse(
    await client.request({ op: "upload.begin", path: "a", expected: null, size: 2 }),
  );
  client.socket.send(encodeFileFrame(upload.channel, 0, Buffer.from("a")));
  client.socket.send(encodeFileFrame(upload.channel, 1, Buffer.from("b")));
  const responses = [await client.next(), await client.next()];
  expect(responses).toContainEqual(expect.objectContaining({ type: "files.error", code: "QUOTA" }));
  expect(responses).toContainEqual(expect.objectContaining({ type: "files.upload", offset: 1 }));
  expect(
    await client.request({
      op: "upload.commit",
      uploadId: upload.uploadId,
      sha256: createHash("sha256").update("ab").digest("hex"),
    }),
  ).toMatchObject({ code: "INCOMPLETE" });
});

it("revokes an active download and upload as soon as the next chunk is requested", async () => {
  let allowed = true;
  const f = await setup({ authorize: () => allowed });
  const client = await f.connect();
  await writeFile(join(f.root, "a"), "data");
  const download = z
    .object({ channel: z.number() })
    .parse(await client.request({ op: "download", path: "a", offset: 0 }));
  const upload = Upload.parse(
    await client.request({ op: "upload.begin", path: "b", expected: null, size: 1 }),
  );
  allowed = false;
  client.send({ type: "files.credit", channel: download.channel, credits: 1 });
  expect(await client.next()).toMatchObject({ code: "FORBIDDEN" });
  client.socket.send(encodeFileFrame(upload.channel, 0, Buffer.from("a")));
  expect(await client.next()).toMatchObject({ code: "FORBIDDEN" });
  await expect(readFile(join(f.root, "b"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps uploads device-bound and removes expired temporary files without changing their destination", async () => {
  let now = 10;
  const f = await setup({ now: () => now, retentionMs: 10 });
  const client = await f.connect();
  await writeFile(join(f.root, "a"), "old");
  const current = Version.parse(await client.request({ op: "stat", path: "a" })).value.version;
  const upload = Upload.parse(
    await client.request({ op: "upload.begin", path: "a", expected: current, size: 1 }),
  );
  await expect(
    f.service.request("other-device", { op: "upload.resume", uploadId: upload.uploadId }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  now = 21;
  await f.service.sweep();
  expect(await client.request({ op: "upload.resume", uploadId: upload.uploadId })).toMatchObject({
    code: "NOT_FOUND",
  });
  expect(await readdir(f.root)).toEqual(["a"]);
  expect(await readFile(join(f.root, "a"), "utf8")).toBe("old");
});

it("caps and expires archive previews", async () => {
  let now = 0;
  const f = await setup({ now: () => now });
  const client = await f.connect();
  for (let i = 0; i < 4; i++)
    expect(
      await client.request({ op: "archive.preview", path: "", includeIgnored: false }),
    ).toMatchObject({ type: "files.result" });
  expect(
    await client.request({ op: "archive.preview", path: "", includeIgnored: false }),
  ).toMatchObject({ code: "BUSY" });
  now = 300001;
  expect(
    await client.request({ op: "archive.preview", path: "", includeIgnored: false }),
  ).toMatchObject({ type: "files.result" });
});
