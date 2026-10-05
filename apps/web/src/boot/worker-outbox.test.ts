// @vitest-environment node
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";
import { expect, test } from "vitest";

/*
 * The client worker's outbox as the app boots it, in a real browser's IndexedDB (UX audit SY-5,
 * review of #126): sends saved offline by two workers or windows both survive a reload.
 */

async function inBrowser<T>(script: string): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "ace-worker-outbox-"));
  const bundle = join(root, "entry.js");
  try {
    await promisify(execFile)("bun", [
      "build",
      fileURLToPath(new URL("./fixtures/offline-sends.ts", import.meta.url)),
      "--target=browser",
      `--outfile=${bundle}`,
    ]);
    const source = await readFile(bundle, "utf8");
    const server = createServer((request, response) => {
      const entry = request.url === "/entry.js";
      response.setHeader("content-type", entry ? "application/javascript" : "text/html");
      response.end(entry ? source : "<!doctype html><title>Outbox</title>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch({ headless: true });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a loopback port");
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${address.port}/`);
      return (await page.evaluate(script)) as T;
    } finally {
      await browser.close();
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("sends saved offline by two workers on one outbox both survive a reload", async () => {
  const waiting = await inBrowser<string[]>(`(async () => {
    const outbox = await import("/entry.js");
    await outbox.twoWorkersSend();
    return outbox.afterReload();
  })()`);
  expect(waiting).toEqual(["send-a", "send-b"]);
}, 60_000);
