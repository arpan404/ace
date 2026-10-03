import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { BrowserService, installChromium, type ChromiumArtifact } from "./index.ts";
import { archive } from "./archive-test-support.ts";
import type { BrowserDownloadProgress } from "@ace/protocol";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
async function downloadFixture(
  data = archive([{ name: "chrome/chrome", data: "browser executable" }]),
) {
  const home = await mkdtemp(join(tmpdir(), "ace-chromium-"));
  let downloads = 0,
    body = data;
  const server = createServer((_request, response) => {
    downloads++;
    response.setHeader("content-length", body.length);
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  const artifact: ChromiumArtifact = {
    version: "1.2.3.4",
    url: `http://127.0.0.1:${address.port}/chrome.zip`,
    checksum: createHash("md5").update(data).digest("hex"),
    executable: "chrome/chrome",
  };
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  });
  return {
    home,
    artifact,
    get downloads() {
      return downloads;
    },
    replace(replacement: Buffer) {
      body = replacement;
    },
  };
}
it("streams and verifies the pinned archive before publishing an ace-owned executable and reports progress", async () => {
  const f = await downloadFixture();
  const progress: BrowserDownloadProgress[] = [];
  const path = await installChromium(f.home, {
    artifact: f.artifact,
    progress: (event) => progress.push(event),
  });
  expect(path).toContain(join(f.home, "chromium", "1.2.3.4-"));
  expect(await readFile(path, "utf8")).toBe("browser executable");
  expect(progress.map((event) => event.phase)).toContain("verifying");
  expect(progress.at(-1)).toMatchObject({ phase: "ready", received: progress.at(-1)?.total });
  expect(await installChromium(f.home, { artifact: f.artifact })).toBe(path);
  expect(f.downloads).toBe(1);
});
it("rejects a mismatched checksum, cleans partial files and allows a successful retry", async () => {
  const f = await downloadFixture();
  f.replace(archive([{ name: "chrome/chrome", data: "tampered executable" }]));
  await expect(installChromium(f.home, { artifact: f.artifact })).rejects.toThrow("checksum");
  expect(await readdir(join(f.home, "chromium"))).toEqual([]);
  f.replace(archive([{ name: "chrome/chrome", data: "browser executable" }]));
  expect(await readFile(await installChromium(f.home, { artifact: f.artifact }), "utf8")).toBe(
    "browser executable",
  );
});
it("redownloads a cache whose executable bytes no longer match its verification marker", async () => {
  const f = await downloadFixture();
  const path = await installChromium(f.home, { artifact: f.artifact });
  await writeFile(path, "truncated");
  expect(await readFile(await installChromium(f.home, { artifact: f.artifact }), "utf8")).toBe(
    "browser executable",
  );
  expect(f.downloads).toBe(2);
});
it.each([
  { entries: [{ name: "../outside", data: "escape" }] },
  { entries: [{ name: "chrome/link", data: "../../outside", mode: 0o120777 }] },
])(
  "rejects checksum-valid archives that escape the installation directory %#",
  async ({ entries }) => {
    const f = await downloadFixture(archive(entries));
    await expect(installChromium(f.home, { artifact: f.artifact })).rejects.toThrow();
    expect(await readdir(join(f.home, "chromium"))).toEqual([]);
  },
);
it("shutdown cancellation removes an interrupted streamed download instead of publishing it", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-chromium-abort-"));
  const entered = Promise.withResolvers<void>();
  const controller = new AbortController();
  const server = createServer((_request, response) => {
    response.writeHead(200);
    response.write("partial");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  });
  const failed = expect(
    installChromium(home, {
      artifact: {
        version: "1.2.3.4",
        url: `http://127.0.0.1:${address.port}/`,
        checksum: "0".repeat(32),
        executable: "chrome",
      },
      signal: controller.signal,
      progress: (event) => {
        if (event.received > 0) entered.resolve();
      },
    }),
  ).rejects.toThrow();
  await entered.promise;
  controller.abort();
  await failed;
  expect(await readdir(join(home, "chromium"))).toEqual([]);
});

it("concurrent headless opens share one verified download instead of running competing installers", async () => {
  const f = await downloadFixture();
  const service = new BrowserService({
    dataDir: f.home,
    acquisition: { artifact: f.artifact },
    launchContext: async () => {
      throw new Error("Launch boundary reached after installation");
    },
  });
  cleanups.push(() => service.close());
  const results = await Promise.allSettled([
    service.open({ threadId: "one", workspaceId: "workspace" }),
    service.open({ threadId: "two", workspaceId: "workspace" }),
  ]);
  expect(results.every((result) => result.status === "rejected")).toBe(true);
  expect(f.downloads).toBe(1);
  expect(await readdir(join(f.home, "browser"))).toEqual([]);
  expect(await readdir(join(f.home, "chromium"))).toHaveLength(1);
});
