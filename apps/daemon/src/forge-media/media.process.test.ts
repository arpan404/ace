import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { fakeGh } from "@ace/forge/testing";
import { WorkspaceActionRequest, type ForgeMediaRequest } from "@ace/protocol";
import { Store } from "../store.ts";
import { readConfig } from "../config.ts";
import { WorkspaceRuntime } from "../workspace-runtime.ts";
import { FilesWorkspaces } from "../files-workspaces.ts";
import { projectFilesBinding } from "../project-files-binding.ts";
import { ForgeMediaCache, forgeMediaRoot } from "./media-cache.ts";
import { mediaHostAllowed } from "./media-fetch.ts";
import { localMediaHost, png, signedFiles } from "./media-test-hosts.ts";
import { ForgeMediaService } from "./media-service.ts";
import { mediaDimensions, sniffMedia } from "./media-sniff.ts";

const execute = promisify(execFile);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const asset = "98705180-e07b-4a5d-b44e-2941ed073508";
const jwt = (token: string, exp: number) =>
  ["e30", Buffer.from(JSON.stringify({ exp, token })).toString("base64url"), "sig"].join(".");
const signedUrl = (token: string) =>
  `https://private-user-images.githubusercontent.com/1/2-${asset}.png?jwt=${jwt(token, 2_000_000_000)}`;
const renderedImage = (url: string) =>
  `<p>ACEMEDIANONCEN0X</p>\n<a href="${url}"><img src="${url}"></a>`;
const scope = (workspaceId: string, repository = "github.com/octo/ace") => ({
  host: "github.com",
  repository,
  workspaceId,
});

async function project() {
  const root = await mkdtemp(join(tmpdir(), "ace-forge-media-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await execute("git", ["init", root]);
  await execute("git", ["-C", root, "remote", "add", "origin", "https://github.com/octo/ace.git"]);
  const store = new Store(join(root, "events.sqlite"));
  cleanups.push(async () => store.close());
  return { root, store, workspaceId: store.createWorkspace(root, "Project") };
}

const resolve = (runtime: WorkspaceRuntime, workspaceId: string, items: ForgeMediaRequest[]) =>
  runtime
    .read(
      WorkspaceActionRequest.parse({
        type: "workspace.request",
        requestId: "media",
        operation: { op: "forge.media.resolve", workspaceId, items },
      }),
    )
    .then((reply) =>
      reply.result.kind === "forge" && reply.result.data.resource === "media"
        ? reply.result.data.items
        : undefined,
    );

test("an expired signed URL is rendered again, and the bytes then serve every later read and download", async () => {
  const { root, store, workspaceId } = await project();
  const gh = await fakeGh({
    markdown: [
      { raw: renderedImage(signedUrl("stale")) },
      { raw: renderedImage(signedUrl("fresh")) },
    ],
  });
  cleanups.push(() => gh.cleanup());
  const host = await localMediaHost(
    signedFiles(
      { [`/1/2-${asset}.png`]: { body: png, type: "application/octet-stream" } },
      () => "fresh",
    ),
    cleanups,
  );
  const config = readConfig({ ACE_HOME: root }, root);
  const dataDir = config.dataDir;
  const files = new FilesWorkspaces({
    store,
    config,
    options: {},
    now: () => 1000,
    id: randomUUID,
  });
  cleanups.push(() => files.close());
  const caches: ForgeMediaCache[] = [];
  const runtimeWith = () =>
    new WorkspaceRuntime(store, dataDir, () => 1000, {
      forgeRunner: () => (request) => gh.runner({ ...request, command: gh.executable }),
      forgeMedia: () => {
        const cache = new ForgeMediaCache(forgeMediaRoot(dataDir));
        caches.push(cache);
        return new ForgeMediaService({
          cache,
          now: () => 1000,
          grants: files.forgeMedia.grants,
          fetch: (url, temporary) => host.fetch(url, temporary),
        });
      },
    });
  const item = {
    url: `https://github.com/user-attachments/assets/${asset}`,
    role: "image" as const,
  };
  const sha256 = createHash("sha256").update(png).digest("hex");
  const ready = { state: "ready", kind: "image", mimeType: "image/png", bytes: png.length, sha256 };
  expect(await resolve(runtimeWith(), workspaceId, [item])).toEqual([ready]);
  expect((await gh.requests()).filter((request) => request.path === "markdown")).toHaveLength(2);

  // A restarted daemon (its index written as it stopped) answers from its cache and asks
  // GitHub nothing.
  await Promise.all(caches.map((cache) => cache.flushed()));
  expect(await resolve(runtimeWith(), workspaceId, [item])).toEqual([ready]);
  expect((await gh.requests()).filter((request) => request.path === "markdown")).toHaveLength(2);

  // Clients read the bytes by hash through the project's read-only download.
  const binding = await projectFilesBinding(
    files,
    workspaceId,
    { op: "forge.media.download", sha256, offset: 0 },
    () => true,
  );
  const download = await binding.service.downloadForTransport("device", binding.operation);
  const parts: Buffer[] = [];
  for await (const chunk of download.chunks) parts.push(chunk);
  await download.close();
  expect(Buffer.concat(parts).equals(png)).toBe(true);
  expect(binding.allowed("operate")).toBe(false);

  // Another project never resolved it: knowing the hash isn't enough to read it.
  const other = store.createWorkspace(join(root, "other"), "Other");
  await expect(
    projectFilesBinding(
      files,
      other,
      { op: "forge.media.download", sha256, offset: 0 },
      () => true,
    ),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("bytes that are not media are refused whatever their host claims, and SVG is only an image", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-forge-media-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const svg = Buffer.from(
    '<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  );
  const host = await localMediaHost(
    signedFiles(
      {
        "/page.png": {
          body: Buffer.from("<!doctype html><script>alert(1)</script>"),
          type: "image/png",
        },
        "/logo.svg": { body: svg, type: "text/plain" },
        "/huge.png": { body: Buffer.concat([png, Buffer.alloc(4096)]), type: "image/png" },
      },
      () => "",
    ),
    cleanups,
  );
  const urls: Record<string, string> = {
    "https://example.com/page.png": "https://camo.githubusercontent.com/page.png",
    "https://example.com/logo.svg": "https://camo.githubusercontent.com/logo.svg",
    "https://example.com/huge.png": "https://camo.githubusercontent.com/huge.png",
    "https://example.com/elsewhere.png": "https://evil.example/elsewhere.png",
  };
  const cache = new ForgeMediaCache(root);
  cleanups.push(() => cache.flushed());
  const service = new ForgeMediaService({
    cache,
    now: () => 1000,
    fetch: (url, temporary) => host.fetch(url, temporary, { maxBytes: 2048 }),
  });
  const render = async (items: readonly ForgeMediaRequest[]) =>
    items.map((item) => ({
      kind: "image" as const,
      url: urls[item.url] ?? "",
      expiresAt: undefined,
    }));
  const items = Object.keys(urls).map((url) => ({ url, role: "image" as const }));
  const results = await service.resolve(scope("ace"), render, items);
  expect(results.map((result) => (result.state === "ready" ? result.mimeType : result))).toEqual([
    { state: "unavailable", reason: "unsupported" },
    "image/svg+xml",
    { state: "unavailable", reason: "too_large" },
    { state: "unavailable", reason: "forbidden" },
  ]);
});

test("the cache keeps to its byte budget, dropping the least recently used, across a restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-forge-media-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const limits = { maxBytes: 2500, maxFiles: 10 };
  const cache = new ForgeMediaCache(root, limits);
  const put = async (key: string, fill: number) => {
    const bytes = Buffer.alloc(1000, fill);
    const temporary = cache.temporary();
    await writeFile(temporary, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await cache.adopt(
      key,
      temporary,
      { sha256, mimeType: "image/png", kind: "image", bytes: 1000 },
      1,
    );
  };
  await put("github.com/o/r asset:a", 1);
  await put("github.com/o/r asset:b", 2);
  expect(cache.lookup("github.com/o/r asset:a", 1)).toBeDefined(); // a is now the most recently used
  await put("github.com/o/r asset:c", 3);
  expect(cache.size).toEqual({ files: 2, bytes: 2000 });
  expect(cache.lookup("github.com/o/r asset:b", 1)).toBeUndefined();
  await cache.flushed();
  const reopened = new ForgeMediaCache(root, limits);
  expect(reopened.lookup("github.com/o/r asset:a", 1)?.fresh).toBe(true);
  expect(reopened.lookup("github.com/o/r asset:c", 1)?.fresh).toBe(true);
  expect(reopened.lookup("github.com/o/r asset:b", 1)).toBeUndefined();
  // Non-attachment media is fetched again after its week.
  await put("github.com/o/r url:https://example.com/a.png", 4);
  expect(
    cache.lookup("github.com/o/r url:https://example.com/a.png", 1 + 8 * 24 * 3600_000)?.fresh,
  ).toBe(false);
});

test("an image's pixel size is read from its header so pages can hold its space", () => {
  const ihdr = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(ihdr);
  ihdr.writeUInt32BE(13, 8);
  ihdr.write("IHDR", 12, "ascii");
  ihdr.writeUInt32BE(1920, 16);
  ihdr.writeUInt32BE(1080, 20);
  expect(sniffMedia(ihdr)).toEqual({ kind: "image", mimeType: "image/png" });
  expect(mediaDimensions(ihdr, "image/png")).toEqual({ width: 1920, height: 1080 });
  const gif = Buffer.from("GIF89a\x40\x01\xf0\x00", "latin1");
  expect(mediaDimensions(gif, "image/gif")).toEqual({ width: 320, height: 240 });
});

test("only the forge's own media hosts are fetched", () => {
  expect(
    mediaHostAllowed("https://private-user-images.githubusercontent.com/1/2.png", "github.com"),
  ).toBe(true);
  expect(mediaHostAllowed("https://camo.githubusercontent.com/x", "github.com")).toBe(true);
  expect(mediaHostAllowed("http://camo.githubusercontent.com/x", "github.com")).toBe(false);
  expect(mediaHostAllowed("https://example.com/a.png", "github.com")).toBe(false);
  expect(mediaHostAllowed("https://media.ghe.corp/u/1", "ghe.corp")).toBe(true);
  expect(mediaHostAllowed("https://ghe.corp.evil/u/1", "ghe.corp")).toBe(false);
});
