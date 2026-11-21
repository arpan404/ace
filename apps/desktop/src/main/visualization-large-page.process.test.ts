import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { visualizationFrame } from "@ace/html";
import { headless, runElectron } from "./isolation-test-support.ts";

/**
 * Real Electron: Chromium loads no URL over 2 MiB, so a page of a few MiB (screenshots inlined
 * as base64) that travelled inside its frame's `data:` URL stayed blank. The outer document now
 * loads small and is handed the page; here a 3 MiB page opened in its own window renders and
 * reports its height.
 */

const here = dirname(fileURLToPath(import.meta.url));

const harness = `
import { app } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { isolateVisualizationSession, openVisualizationWindow } from "./visualization-isolation.ts";
const config = JSON.parse(readFileSync(process.argv.at(-1), "utf8"));
const finish = (title) => {
  writeFileSync(config.out, JSON.stringify({ title }));
  app.exit(0);
};
app.whenReady().then(async () => {
  await isolateVisualizationSession();
  const window = openVisualizationWindow({ title: "Large page", url: config.url, page: config.page });
  window.webContents.on("page-title-updated", (_event, title) => {
    if (title.startsWith("ace.html.height:")) finish(title);
  });
  setTimeout(() => finish(null), 20000);
});
`;

it.skipIf(headless)(
  "a visualization larger than Chromium's 2 MiB URL limit still renders in its window",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ace-visual-large-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const filler = "A".repeat(3 * 1024 * 1024);
    const html = `<!doctype html><html><head><title>Large</title></head><body><div style="height:321px">Large page</div><p hidden>${filler}</p></body></html>`;
    const framed = visualizationFrame(html, { colorScheme: "dark" }, "static", 2);
    expect(framed.page.length).toBeGreaterThan(2 * 1024 * 1024);
    const out = join(root, "result.json");
    await runElectron(harness, here, root, { ...framed, out }, "large page");
    const result = z
      .object({ title: z.string().nullable() })
      .parse(JSON.parse(await readFile(out, "utf8")));
    const height = Number(/^ace\.html\.height:(\d+)$/.exec(result.title ?? "")?.[1]);
    expect(height).toBeGreaterThanOrEqual(321);
  },
);
