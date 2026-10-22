import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
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
import { fetchMedia, mediaHostAllowed } from "./media-fetch.ts";
import { ForgeMediaService } from "./media-service.ts";

const execute = promisify(execFile);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const asset = "98705180-e07b-4a5d-b44e-2941ed073508";
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(600, 7),
]);
const jwt = (token: string, exp: number) =>
  ["e30", Buffer.from(JSON.stringify({ exp, token })).toString("base64url"), "sig"].join(".");
const signedUrl = (token: string) =>
  `https://private-user-images.githubusercontent.com/1/2-${asset}.png?jwt=${jwt(token, 2_000_000_000)}`;
const renderedImage = (url: string) => `<p>ACEMEDIA0X</p>\n<a href="${url}"><img src="${url}"></a>`;

/** GitHub's media host, played locally: a signed URL works only while its token is current. */
async function mediaHost(files: Record<string, { body: Buffer; type: string }>, current: string) {
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://local");
    const token = url.searchParams.get("jwt");
    if (token) {
      const payload = Buffer.from(token.split(".")[1] ?? "", "base64url").toString();
      if (!payload.includes(`"token":"${current}"`)) {
        response.writeHead(403).end("Request has expired");
        return;
      }
    }
    const file = files[url.pathname];
    if (!file) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": file.type }).end(file.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  // Fetch what GitHub named from the local stand-in, keeping its path and query.
  return (url: string, temporary: string, maxBytes = 1024 * 1024) => {
    const parsed = new URL(url);
    return fetchMedia(`http://127.0.0.1:${port}${parsed.pathname}${parsed.search}`, temporary, {
      maxBytes,
      allowed: () => true,
    });
  };
}

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
  const host = await mediaHost(
    { [`/1/2-${asset}.png`]: { body: png, type: "application/octet-stream" } },
    "fresh",
  );
  const dataDir = readConfig({ ACE_HOME: root }, root).dataDir;
  const runtimeWith = () =>
    new WorkspaceRuntime(store, dataDir, () => 1000, {
      forgeRunner: () => (request) => gh.runner({ ...request, command: gh.executable }),
      forgeMedia: () =>
        new ForgeMediaService({
          cache: new ForgeMediaCache(forgeMediaRoot(dataDir)),
          now: () => 1000,
          fetch: (url, temporary) => host(url, temporary),
        }),
    });
  const item = {
    url: `https://github.com/user-attachments/assets/${asset}`,
    role: "image" as const,
  };
  const sha256 = createHash("sha256").update(png).digest("hex");
  const ready = { state: "ready", kind: "image", mimeType: "image/png", bytes: png.length, sha256 };
  expect(await resolve(runtimeWith(), workspaceId, [item])).toEqual([ready]);
  expect((await gh.requests()).filter((request) => request.path === "markdown")).toHaveLength(2);

  // A restarted daemon answers from its cache and asks GitHub nothing.
  expect(await resolve(runtimeWith(), workspaceId, [item])).toEqual([ready]);
  expect((await gh.requests()).filter((request) => request.path === "markdown")).toHaveLength(2);

  // Clients read the bytes by hash through the project's read-only download.
  const config = readConfig({ ACE_HOME: root }, root);
  const files = new FilesWorkspaces({
    store,
    config,
    options: {},
    now: () => 1000,
    id: randomUUID,
  });
  cleanups.push(() => files.close());
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
});

test("bytes that are not media are refused whatever their host claims, and SVG is only an image", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-forge-media-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const svg = Buffer.from(
    '<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  );
  const host = await mediaHost(
    {
      "/page.png": {
        body: Buffer.from("<!doctype html><script>alert(1)</script>"),
        type: "image/png",
      },
      "/logo.svg": { body: svg, type: "text/plain" },
      "/huge.png": { body: Buffer.concat([png, Buffer.alloc(4096)]), type: "image/png" },
    },
    "",
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
    fetch: (url, temporary) => host(url, temporary, 2048),
  });
  const render = async (items: readonly ForgeMediaRequest[]) =>
    items.map((item) => ({
      kind: "image" as const,
      url: urls[item.url] ?? "",
      expiresAt: undefined,
    }));
  const items = Object.keys(urls).map((url) => ({ url, role: "image" as const }));
  const results = await service.resolve("github.com", render, items, new AbortController().signal);
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
  await put("asset:a", 1);
  await put("asset:b", 2);
  expect(cache.lookup("asset:a", 1)).toBeDefined(); // a is now the most recently used
  await put("asset:c", 3);
  expect(cache.size).toEqual({ files: 2, bytes: 2000 });
  expect(cache.lookup("asset:b", 1)).toBeUndefined();
  await cache.flushed();
  const reopened = new ForgeMediaCache(root, limits);
  expect(reopened.lookup("asset:a", 1)?.fresh).toBe(true);
  expect(reopened.lookup("asset:c", 1)?.fresh).toBe(true);
  expect(reopened.lookup("asset:b", 1)).toBeUndefined();
  // Non-attachment media is fetched again after its week.
  await put("url:https://example.com/a.png", 4);
  expect(cache.lookup("url:https://example.com/a.png", 1 + 8 * 24 * 3600_000)?.fresh).toBe(false);
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
