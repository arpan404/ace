import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrcpyServerJar } from "./scrcpy-jar.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
const jar = Buffer.from("pinned scrcpy server bytes");
const release = {
  version: "9.9",
  bytes: jar.length,
  sha256: createHash("sha256").update(jar).digest("hex"),
  url: "https://example.invalid/scrcpy-server-v9.9",
};

/** A real local HTTP server stands in for the release download. */
async function mirror(body: Buffer) {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const local: typeof fetch = (_url, init) => fetch(`http://127.0.0.1:${address.port}/`, init);
  return { fetch: local, requests: () => requests };
}
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "ace-scrcpy-jar-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

it("downloads the pinned server once, then reuses the verified copy without the network", async () => {
  const root = await directory();
  const server = await mirror(jar);
  const options = { directory: root, env: {}, fetch: server.fetch, id: () => "a", release };
  const path = await scrcpyServerJar(options);
  expect(path).toBe(join(root, "scrcpy-server-v9.9"));
  expect(await scrcpyServerJar(options)).toBe(path);
  expect(server.requests()).toBe(1);
  expect(await readdir(root)).toEqual(["scrcpy-server-v9.9"]);
});

it("a download that fails its checksum is refused and leaves nothing behind", async () => {
  const root = await directory();
  const server = await mirror(Buffer.from("pinned scrcpy server bytez"));
  await expect(
    scrcpyServerJar({ directory: root, env: {}, fetch: server.fetch, id: () => "a", release }),
  ).rejects.toMatchObject({ code: "tool_missing" });
  expect(await readdir(root)).toEqual([]);
});

it("a tampered cached copy is replaced by a fresh verified download", async () => {
  const root = await directory();
  await writeFile(join(root, "scrcpy-server-v9.9"), "tampered");
  const server = await mirror(jar);
  await scrcpyServerJar({ directory: root, env: {}, fetch: server.fetch, id: () => "a", release });
  expect(server.requests()).toBe(1);
});

it("an explicit ACE_SCRCPY_SERVER must be the pinned release", async () => {
  const root = await directory();
  const wrong = join(root, "server");
  await writeFile(wrong, "another version");
  const server = await mirror(jar);
  await expect(
    scrcpyServerJar({
      directory: root,
      env: { ACE_SCRCPY_SERVER: wrong },
      fetch: server.fetch,
      id: () => "a",
      release,
    }),
  ).rejects.toMatchObject({ code: "tool_missing" });
  expect(server.requests()).toBe(0);
});
