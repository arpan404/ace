import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ForgeError } from "@ace/forge";
import type { ForgeMediaRequest } from "@ace/protocol";
import { ForgeMediaCache } from "./media-cache.ts";
import { fetchMedia, forgeAddressPolicy } from "./media-fetch.ts";
import { ForgeMediaGrants } from "./media-grants.ts";
import { ForgeMediaService } from "./media-service.ts";
import { localMediaHost, png } from "./media-test-hosts.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function folder() {
  const root = await mkdtemp(join(tmpdir(), "ace-forge-media-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
const scope = (workspaceId: string, repository = "github.com/octo/ace") => ({
  host: "github.com",
  repository,
  workspaceId,
});
const image = (url: string): ForgeMediaRequest => ({ url, role: "image" });
/** A repository check the forge refuses, and one it can't answer now. */
const refused = async () => {
  throw new ForgeError("forbidden", undefined, false);
};
const offline = async () => {
  throw new ForgeError("offline");
};
/** GitHub's rendering of every item as one proxied file. */
const renderedAs =
  (kind: "image" | "video", url: string) => async (items: readonly ForgeMediaRequest[]) =>
    items.map(() => ({ kind, url, expiresAt: undefined }));

test("a redirect that leaves the forge's media hosts is refused, not followed", async () => {
  const host = await localMediaHost((_request, response, url) => {
    if (url.pathname === "/start")
      response.writeHead(302, { location: `http://localhost:${host.port}/tracker.png` }).end();
    else response.writeHead(200, { "content-type": "image/png" }).end(png);
  }, cleanups);
  const root = await folder();
  const result = await host.fetch("https://camo.githubusercontent.com/start", join(root, "a.tmp"), {
    // Every hop must pass: here, only the host GitHub named.
    hop: (hop) => hop.hostname === "127.0.0.1",
  });
  expect(result).toEqual({ kind: "refused" });
  expect(host.requests()).toBe(1);
});

test("an Enterprise forge's own private addresses may be reached; nothing else private may", () => {
  const ghe = forgeAddressPolicy("ghe.corp");
  expect(ghe("10.1.2.3", 443, "ghe.corp")).toBe(true);
  expect(ghe("10.1.2.3", 443, "media.ghe.corp")).toBe(true);
  expect(ghe("10.1.2.3", 443, "intranet.example")).toBe(false);
  expect(ghe("10.1.2.3", 80, "ghe.corp")).toBe(false);
  expect(ghe("140.82.112.3", 443, "anything.example")).toBe(true);
  const github = forgeAddressPolicy("github.com");
  expect(github("10.1.2.3", 443, "github.com")).toBe(false);
  expect(github("140.82.112.3", 443, "camo.githubusercontent.com")).toBe(true);
});

test("a large file that keeps arriving slowly finishes; one that stalls gives up at its idle time", async () => {
  const host = await localMediaHost((_request, response, url) => {
    response.writeHead(200, { "content-type": "image/png" });
    response.write(png.subarray(0, 64));
    if (url.pathname === "/stall") return;
    // Sixteen pieces 150 ms apart: longer in all than four idle periods.
    let sent = 0;
    const timer = setInterval(() => {
      response.write(Buffer.alloc(64, sent));
      if (++sent === 16) {
        clearInterval(timer);
        response.end();
      }
    }, 150);
  }, cleanups);
  const root = await folder();
  const slow = await host.fetch("https://camo.githubusercontent.com/slow", join(root, "a.tmp"), {
    idleMs: 400,
  });
  expect(slow).toMatchObject({ kind: "ok", bytes: 64 + 16 * 64 });
  const started = performance.now();
  const stalled = await host.fetch(
    "https://camo.githubusercontent.com/stall",
    join(root, "b.tmp"),
    {
      idleMs: 300,
    },
  );
  expect(stalled).toEqual({ kind: "failed" });
  expect(performance.now() - started).toBeLessThan(5_000);
});

test("a fetch that keeps failing is asked for less and less often", async () => {
  const host = await localMediaHost((_request, response) => {
    response.writeHead(500).end();
  }, cleanups);
  let now = 0;
  const service = new ForgeMediaService({
    cache: new ForgeMediaCache(await folder()),
    now: () => now,
    fetch: (url, temporary) => host.fetch(url, temporary),
  });
  const ask = async (at: number) => {
    now = at;
    return service.resolve(
      scope("ace"),
      renderedAs("video", "https://camo.githubusercontent.com/big.mp4"),
      [image("https://example.com/big.mp4")],
    );
  };
  expect(await ask(0)).toEqual([{ state: "unavailable", reason: "failed" }]);
  await ask(16_000);
  expect(host.requests()).toBe(2);
  // The second failure waits twice as long: 40 s is still within it.
  await ask(40_000);
  expect(host.requests()).toBe(2);
  await ask(47_000);
  expect(host.requests()).toBe(3);
});

test("bytes kept from before still answer after a refresh of them fails", async () => {
  let gone = false;
  const host = await localMediaHost((_request, response) => {
    if (gone) response.writeHead(404).end();
    else response.writeHead(200, { "content-type": "image/png" }).end(png);
  }, cleanups);
  let now = 0;
  const service = new ForgeMediaService({
    cache: new ForgeMediaCache(await folder(), { ttlMs: 1000 }),
    now: () => now,
    fetch: (url, temporary) => host.fetch(url, temporary),
  });
  const item = image("https://example.com/a.png");
  const render = renderedAs("image", "https://camo.githubusercontent.com/a.png");
  const [first] = await service.resolve(scope("ace"), render, [item]);
  expect(first).toMatchObject({ state: "ready", bytes: png.length });
  gone = true;
  now = 5000;
  // Past its life: answered from what's kept while a refresh runs behind it, and fails.
  expect((await service.resolve(scope("ace"), render, [item]))[0]).toEqual(first);
  await expect.poll(() => host.requests()).toBe(2);
  // The failed refresh is remembered, yet the kept bytes still answer.
  expect((await service.resolve(scope("ace"), render, [item]))[0]).toEqual(first);
});

test("what one repository's text resolved is never answered for another's, and only its project may read it", async () => {
  const host = await localMediaHost((_request, response) => {
    response.writeHead(200, { "content-type": "image/png" }).end(png);
  }, cleanups);
  let renders = 0;
  const grants = new ForgeMediaGrants();
  const service = new ForgeMediaService({
    cache: new ForgeMediaCache(await folder()),
    now: () => 0,
    grants,
    fetch: (url, temporary) => host.fetch(url, temporary),
  });
  const render = async (items: readonly ForgeMediaRequest[]) => {
    renders++;
    return items.map(() => ({
      kind: "image" as const,
      url: "https://private-user-images.githubusercontent.com/1/2.png",
      expiresAt: undefined,
    }));
  };
  const item = image(
    "https://github.com/user-attachments/assets/98705180-e07b-4a5d-b44e-2941ed073508",
  );
  const [a] = await service.resolve(scope("project-a", "github.com/octo/private"), render, [item]);
  if (a?.state !== "ready") throw new Error("Not resolved");
  await service.resolve(scope("project-a", "github.com/octo/private"), render, [item]);
  expect(renders).toBe(1);
  // Another repository asks GitHub itself, through its own access.
  await service.resolve(scope("project-b", "github.com/octo/public"), render, [item]);
  expect(renders).toBe(2);
  expect(grants.allows("project-a", a.sha256)).toBe(true);
  expect(grants.allows("project-c", a.sha256)).toBe(false);
});

test("by default every URL in the chain must be on the forge's media hosts over https", async () => {
  const host = await localMediaHost((_request, response) => {
    response.writeHead(200, { "content-type": "image/png" }).end(png);
  }, cleanups);
  const root = await folder();
  // No `hop` given: the forge's own check applies, and a plain-http local URL is no media host.
  const result = await fetchMedia(`http://127.0.0.1:${host.port}/a.png`, join(root, "a.tmp"), {
    maxBytes: 1024 * 1024,
    forgeHost: "github.com",
    allowed: () => true,
  });
  expect(result).toEqual({ kind: "refused" });
  expect(host.requests()).toBe(0);
});

test("kept bytes are served only while the user's own access still reads their repository", async () => {
  const host = await localMediaHost((_request, response) => {
    response.writeHead(200, { "content-type": "image/png" }).end(png);
  }, cleanups);
  let now = 0;
  const grants = new ForgeMediaGrants();
  const service = new ForgeMediaService({
    cache: new ForgeMediaCache(await folder()),
    now: () => now,
    grants,
    fetch: (url, temporary) => host.fetch(url, temporary),
  });
  const render = renderedAs("image", "https://private-user-images.githubusercontent.com/1/2.png");
  const item = image(
    "https://github.com/user-attachments/assets/98705180-e07b-4a5d-b44e-2941ed073508",
  );
  const repository = "github.com/octo/private";
  const [first] = await service.resolve(scope("project-a", repository), render, [item]);
  if (first?.state !== "ready") throw new Error("Not resolved");
  // Another project naming the repository after the user lost access gets nothing kept.
  now = 1000;
  expect(await service.resolve(scope("project-b", repository), render, [item], refused)).toEqual([
    { state: "unavailable", reason: "forbidden" },
  ]);
  expect(grants.allows("project-b", first.sha256)).toBe(false);
  // While the repository reads, kept bytes answer and the project may download them.
  expect(
    await service.resolve(scope("project-b", repository), render, [item], async () => {}),
  ).toEqual([first]);
  expect(grants.allows("project-b", first.sha256)).toBe(true);
  // A check that can't be answered now (offline) leaves what was resolved before standing.
  now = 20 * 60_000;
  expect(await service.resolve(scope("project-c", repository), render, [item], offline)).toEqual([
    first,
  ]);
});
