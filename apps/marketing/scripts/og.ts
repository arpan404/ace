/*
 * Photographs the social cards (src/pages/og/[name].astro) into public/og.png and
 * public/og/<name>.png. Run it against a running dev or preview server:
 *
 *   bun apps/marketing/scripts/og.ts [http://127.0.0.1:4321]
 *
 * It borrows the desktop app's playwright-core rather than adding a dependency here, and uses
 * Playwright's own Chromium if installed (`bunx playwright install chromium`), else Chrome.
 */
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { cardImage, cards, cardSize } from "../src/seo/cards.ts";

interface Page {
  goto(url: string, options: { waitUntil: "networkidle" }): Promise<unknown>;
  evaluate(script: string): Promise<unknown>;
  screenshot(options: { path: string; type: "png" }): Promise<unknown>;
}
interface Browser {
  newPage(options: {
    viewport: { width: number; height: number };
    deviceScaleFactor: number;
  }): Promise<Page>;
  close(): Promise<void>;
}
interface Chromium {
  launch(options?: { channel?: string }): Promise<Browser>;
}

const base = (process.argv[2] ?? "http://127.0.0.1:4321").replace(/\/$/, "");
const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const require = createRequire(new URL("../../desktop/package.json", import.meta.url));
const { chromium } = require("playwright-core") as { chromium: Chromium };

const browser = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
try {
  const page = await browser.newPage({ viewport: { ...cardSize }, deviceScaleFactor: 1 });
  await mkdir(`${publicDir}og`, { recursive: true });
  for (const card of cards) {
    await page.goto(`${base}/og/${card.name}/`, { waitUntil: "networkidle" });
    await page.evaluate("document.fonts.ready.then(() => true)");
    const path = `${publicDir}${cardImage(card).slice(1)}`;
    await page.screenshot({ path, type: "png" });
    console.log(`${card.name} → ${path}`);
  }
} finally {
  await browser.close();
}
