declare module "vitest" {
  interface ProvidedContext {
    chromiumExecutable: string;
  }
}
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { expect, inject, test } from "vitest";
import { fixtureSetup } from "./fixture.ts";
import { pageFacts, privateScreenshot } from "./dom.ts";
import { checkPage } from "./checks.ts";
import { scrubber } from "./report.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { observeSurfaces } from "./surfaces.ts";

test("the fake daemon renders messy native data and the headless checks reject visible leaks", async () => {
  const server = await createServer({
    root: new URL("../../../apps/web/", import.meta.url).pathname,
    mode: "fake",
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  const browser = await chromium.launch({ executablePath: inject("chromiumExecutable") });
  try {
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture listener");
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      colorScheme: "dark",
    });
    await page.addInitScript(fixtureSetup);
    await page.goto(`http://127.0.0.1:${address.port}/t/smoke-messy`);
    await page.getByRole("feed", { name: "Transcript", exact: true }).waitFor();
    await page
      .getByText('{"type":"native.payload","data":{"unprepared":true}}', { exact: true })
      .waitFor();
    const facts = await page.evaluate(pageFacts, { catalogsReady: true, expected: {} });
    expect(checkPage(facts).map((failure) => failure.code)).toContain("wrapper-tag");
    expect(checkPage(facts).map((failure) => failure.code)).toContain("json-bubble");
    // Corrected prose must remove that failure, proving this is more than a canned verdict.
    await page.locator('[class~="group/answer"]').evaluateAll((elements) => {
      for (const element of elements) element.textContent = "A readable answer";
    });
    expect(
      checkPage(await page.evaluate(pageFacts, { catalogsReady: true, expected: {} })).map(
        (failure) => failure.code,
      ),
    ).not.toContain("json-bubble");
  } finally {
    await browser.close();
    await server.close();
  }
});
test("the DOM collector ignores JSON code examples and secrets are hidden for screenshots", async () => {
  const browser = await chromium.launch({ executablePath: inject("chromiumExecutable") });
  const out = await mkdtemp(join(tmpdir(), "ace-smoke-shot-"));
  try {
    const page = await browser.newPage();
    const secret = `sk-${"x".repeat(30)}`;
    await page.setContent(
      `<div class="group/answer"><pre><code>{"type":"legitimate example"}</code></pre><p>${secret}</p></div><svg role="img" aria-label="Codex"><path d="M0 0L1 1" /></svg>`,
    );
    expect(
      checkPage(await page.evaluate(pageFacts, { catalogsReady: true, expected: {} })),
    ).toEqual([]);
    let atScreenshot = "";
    const screenshot = page.screenshot.bind(page);
    page.screenshot = async (options) => {
      atScreenshot = await page.locator("body").innerText();
      return screenshot(options);
    };
    await privateScreenshot(page, join(out, "redacted.png"), scrubber());
    expect(atScreenshot).not.toContain(secret);
    expect(await page.locator("body").innerText()).toContain(secret);
    await page.evaluate(observeSurfaces);
    await page.evaluate(() => {
      const toast = document.createElement("div");
      toast.setAttribute("role", "alert");
      toast.textContent = "Import failed";
      document.body.append(toast);
      toast.remove();
    });
    expect(
      checkPage(await page.evaluate(pageFacts, { catalogsReady: true, expected: {} })).map(
        (failure) => failure.code,
      ),
    ).toContain("error-surface");
  } finally {
    await browser.close();
    await rm(out, { recursive: true, force: true });
  }
});
