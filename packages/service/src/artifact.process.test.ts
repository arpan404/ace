import { expect, test } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { create } from "tar";
import { checkRelease, boundedText, downloadArchive, hashFile, unpackArchive } from "./index.ts";
test("a signed release is selected through a bounded HTTP edge and binds target and channel", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const bytes = Buffer.from(
    JSON.stringify({
      version: "1.2.3",
      channel: "stable",
      target: "linux-x64",
      archive: "ace-1.2.3-linux-x64.tar.gz",
      bytes: 12,
      sha256: "a".repeat(64),
    }),
  );
  const server = createServer((request, response) => {
    if (request.url === "/feed")
      response.end(
        JSON.stringify({
          draft: false,
          prerelease: false,
          assets: [
            { name: "linux-x64.json", browser_download_url: "https://release.test/manifest" },
            { name: "linux-x64.sig", browser_download_url: "https://release.test/signature" },
            {
              name: "ace-1.2.3-linux-x64.tar.gz",
              browser_download_url: "https://release.test/archive",
            },
          ],
        }),
      );
    else if (request.url === "/manifest") response.end(bytes);
    else response.end(sign(null, bytes, privateKey).toString("base64"));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  try {
    const fetcher = (url: string) =>
      fetch(`http://127.0.0.1:${address.port}${new URL(url).pathname}`);
    const key = publicKey.export({ type: "spki", format: "pem" }).toString();
    const release = await checkRelease(
      fetcher,
      "https://release.test/feed",
      "linux-x64",
      "stable",
      key,
    );
    expect(release.manifest.version).toBe("1.2.3");
    expect(release.url).toBe("https://release.test/archive");
    await expect(
      checkRelease(fetcher, "https://release.test/feed", "linux-x64", "preview", key),
    ).rejects.toThrow("channel");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("oversized feed bodies and archives are refused before they can grow buffers", async () => {
  await expect(boundedText(new Response("abc"), 2)).rejects.toThrow("too large");
  const root = await mkdtemp(join(tmpdir(), "ace-size-"));
  try {
    await expect(
      downloadArchive(new Response("1234"), join(root, "file"), {
        version: "1.0.0",
        target: "linux-x64",
        channel: "stable",
        archive: "ace-test.tar.gz",
        bytes: 3,
        sha256: "a".repeat(64),
      }),
    ).rejects.toThrow("size exceeded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("archive extraction rejects symlinks and does not create files outside staging", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-tar-"));
  try {
    const input = join(root, "input");
    await mkdir(input);
    await writeFile(join(root, "outside"), "safe");
    await symlink("../outside", join(input, "link"));
    const archive = join(root, "bad.tar.gz");
    await create({ file: archive, cwd: input, gzip: true }, ["link"]);
    await expect(unpackArchive(archive, join(root, "staging"))).rejects.toThrow("Unsafe");
    expect(await readFile(join(root, "outside"), "utf8")).toBe("safe");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("streamed hashing reports the expected SHA-256 of file contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-sha-"));
  try {
    const file = join(root, "file");
    await writeFile(file, "abc");
    expect(await hashFile(file)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
