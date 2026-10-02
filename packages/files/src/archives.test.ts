import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, expect, it } from "vitest";
import { decodeFileFrame, CHUNK_SIZE } from "./index.ts";
import { fixture, isolated } from "./test-support.ts";

const run = promisify(execFile);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
async function setup() {
  const f = await fixture();
  cleanup.push(() => f.close());
  return f;
}
const Preview = z.object({
  type: z.literal("files.result"),
  value: z.object({ previewId: z.string(), bytes: z.number(), entries: z.number() }),
});
const Ready = z.object({
  type: z.literal("files.ready"),
  channel: z.number(),
  validator: z.string(),
});

it("streams a folder archive with bounded RSS and excludes ignored files and symlinks", async () => {
  const f = await setup();
  await run("git", ["init", "-q", f.root]);
  await writeFile(join(f.root, ".gitignore"), "ignored/\n");
  await mkdir(join(f.root, "ignored"));
  await writeFile(join(f.root, "ignored", "secret"), "secret");
  await mkdir(join(f.root, "nested"));
  await writeFile(join(f.root, "nested", "text"), "archive text");
  await symlink(f.home, join(f.root, "link"));
  const large = await open(join(f.root, "binary"), "w");
  await large.truncate(200 * 1024 * 1024);
  await large.close();
  const server = await isolated(f.root, join(f.home, "isolated"));
  cleanup.push(() => server.close());
  const client = server.client;
  const preview = Preview.parse(
    await client.request({ op: "archive.preview", path: "", includeIgnored: false }),
  );
  expect(preview.value.bytes).toBe(
    200 * 1024 * 1024 + Buffer.byteLength("archive text") + Buffer.byteLength("ignored/\n"),
  );
  client.send({ type: "test.metrics" });
  const baseline = z.object({ peak: z.number() }).parse(await client.next()).peak;
  const ready = Ready.parse(
    await client.request({ op: "archive.download", previewId: preview.value.previewId }),
  );
  const archivePath = join(f.home, "archive.tar.gz");
  const output = await open(archivePath, "w");
  const digest = createHash("sha256");
  let offset = 0;
  try {
    for (;;) {
      client.send({ type: "files.credit", channel: ready.channel, credits: 1 });
      const message = await client.next();
      if (!Buffer.isBuffer(message)) {
        expect(message).toMatchObject({ type: "files.end", offset, sha256: digest.digest("hex") });
        break;
      }
      const frame = decodeFileFrame(message);
      expect(frame.offset).toBe(offset);
      await output.write(frame.bytes);
      digest.update(frame.bytes);
      offset += frame.bytes.length;
    }
  } finally {
    await output.close();
  }
  client.send({ type: "test.metrics" });
  const peak = z.object({ peak: z.number() }).parse(await client.next()).peak;
  expect(peak - baseline).toBeLessThan(64 * 1024 * 1024);
  const listing = (await run("tar", ["-tzf", archivePath])).stdout.trim().split("\n");
  expect(listing).toContain("binary");
  expect(listing).toContain("nested/text");
  expect(
    listing.some((name) => name.includes("ignored") || name.startsWith(".git/") || name === "link"),
  ).toBe(false);
  const extracted = join(f.home, "extract");
  await mkdir(extracted);
  await run("tar", ["-xzf", archivePath, "-C", extracted]);
  expect(await readFile(join(extracted, "nested", "text"), "utf8")).toBe("archive text");
  const hash = createHash("sha256");
  const handle = await open(join(extracted, "binary"));
  const buffer = Buffer.alloc(CHUNK_SIZE);
  let position = 0;
  try {
    for (;;) {
      const read = await handle.read(buffer, 0, buffer.length, position);
      if (!read.bytesRead) break;
      hash.update(buffer.subarray(0, read.bytesRead));
      position += read.bytesRead;
    }
  } finally {
    await handle.close();
  }
  const expected = createHash("sha256");
  for (let i = 0; i < 3200; i++) expected.update(Buffer.alloc(CHUNK_SIZE));
  expect(hash.digest("hex")).toBe(expected.digest("hex"));
}, 120_000);

it("rejects archives that changed since preview and can explicitly include ignored files", async () => {
  const f = await setup();
  const client = await f.connect();
  await run("git", ["init", "-q", f.root]);
  await writeFile(join(f.root, ".gitignore"), "ignored\n");
  await writeFile(join(f.root, "ignored"), "hidden");
  await writeFile(join(f.root, "a"), "before");
  const defaultPreview = Preview.parse(
    await client.request({ op: "archive.preview", path: "", includeIgnored: false }),
  );
  const inclusive = Preview.parse(
    await client.request({ op: "archive.preview", path: "", includeIgnored: true }),
  );
  expect(inclusive.value.bytes - defaultPreview.value.bytes).toBe(6);
  await writeFile(join(f.root, "a"), "changed");
  const ready = Ready.parse(
    await client.request({ op: "archive.download", previewId: defaultPreview.value.previewId }),
  );
  client.send({ type: "files.credit", channel: ready.channel, credits: 1 });
  for (;;) {
    const next = await client.next();
    if (!Buffer.isBuffer(next)) {
      expect(next).toMatchObject({ type: "files.error", code: "CONFLICT" });
      break;
    }
    client.send({ type: "files.credit", channel: ready.channel, credits: 1 });
  }
});

it("downloads registered daemon artifacts through the same validated binary stream", async () => {
  const f = await setup();
  const client = await f.connect();
  const root = await realpath(f.root);
  const bytes = Buffer.from([0, 255, 3, 77]);
  await writeFile(join(root, "screen.png"), bytes);
  const id = await f.service.registerArtifact({
    root: root,
    path: "screen.png",
    category: "screenshot",
    name: "screen.png",
  });
  expect(await client.request({ op: "artifacts.list" })).toMatchObject({
    type: "files.result",
    value: [expect.objectContaining({ id, category: "screenshot", size: 4 })],
  });
  const ready = Ready.parse(
    await client.request({ op: "artifact.download", artifactId: id, offset: 0 }),
  );
  client.send({ type: "files.credit", channel: ready.channel, credits: 1 });
  expect(decodeFileFrame(z.instanceof(Buffer).parse(await client.next())).bytes).toEqual(bytes);
  expect(await client.next()).toMatchObject({
    type: "files.end",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  await expect(
    f.service.registerArtifact({ root, path: "../outside", category: "output", name: "escape" }),
  ).rejects.toMatchObject({ code: "INVALID_PATH" });
});
it("reports a changed root directory without crashing while an archive waits for credits", async () => {
  const f = await setup();
  const client = await f.connect();
  await writeFile(join(f.root, "a"), "old");
  const preview = Preview.parse(
    await client.request({ op: "archive.preview", path: "", includeIgnored: false }),
  );
  await writeFile(join(f.root, "new"), "new");
  const ready = Ready.parse(
    await client.request({ op: "archive.download", previewId: preview.value.previewId }),
  );
  // A stat reply gives the compression stream a chance to observe the changed root.
  expect(await client.request({ op: "stat", path: "a" })).toMatchObject({ type: "files.result" });
  client.send({ type: "files.credit", channel: ready.channel, credits: 1 });
  expect(await client.next()).toMatchObject({ code: "CONFLICT" });
});
it("archives long UTF-8 filenames with interoperable PAX headers and previews files beyond 8 GiB", async () => {
  const f = await setup();
  const client = await f.connect();
  const name = "界".repeat(70);
  await writeFile(join(f.root, name), "unicode bytes");
  const preview = Preview.parse(
    await client.request({ op: "archive.preview", path: "", includeIgnored: false }),
  );
  const ready = Ready.parse(
    await client.request({ op: "archive.download", previewId: preview.value.previewId }),
  );
  const chunks: Buffer[] = [];
  for (;;) {
    client.send({ type: "files.credit", channel: ready.channel, credits: 1 });
    const next = await client.next();
    if (!Buffer.isBuffer(next)) {
      expect(next).toMatchObject({ type: "files.end" });
      break;
    }
    chunks.push(decodeFileFrame(next).bytes);
  }
  const output = join(f.home, "unicode.tar.gz");
  await writeFile(output, Buffer.concat(chunks));
  const extracted = join(f.home, "unicode");
  await mkdir(extracted);
  await run("tar", ["-xzf", output, "-C", extracted]);
  expect(await readFile(join(extracted, name), "utf8")).toBe("unicode bytes");
  const huge = await open(join(f.root, "huge"), "w");
  await huge.truncate(9 * 1024 ** 3);
  await huge.close();
  const big = Preview.parse(
    await client.request({ op: "archive.preview", path: "", includeIgnored: false }),
  );
  expect(big.value.bytes).toBe(9 * 1024 ** 3 + Buffer.byteLength("unicode bytes"));
  const transfer = Ready.parse(
    await client.request({ op: "archive.download", previewId: big.value.previewId }),
  );
  client.send({ type: "files.cancel", channel: transfer.channel });
  expect(await client.next()).toMatchObject({ type: "files.cancelled" });
});
