declare module "vitest" {
  interface ProvidedContext {
    chromiumExecutable: string;
  }
}
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { expect, inject, test } from "vitest";
import { fixtureSetup } from "./fixture.ts";
import { pageFacts, privateScreenshot, usageScreenshot } from "./dom.ts";
import { checkPage } from "./checks.ts";
import { scrubber } from "./report.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
      toast.className = "group/toast";
      toast.innerHTML =
        '<svg class="text-status-failed"></svg><span>This action needs attention</span>';
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

test("Usage evidence contains its limits and excludes private sidebar content", async () => {
  const browser = await chromium.launch({ executablePath: inject("chromiumExecutable") });
  const out = await mkdtemp(join(tmpdir(), "ace-smoke-usage-"));
  try {
    const page = await browser.newPage();
    await page.setContent(
      "<style>body{margin:0;display:flex}aside{width:200px;height:300px;background:red}main{width:600px;height:300px;background:white;color:black}</style><aside>Private saved thread</aside><main>Usage · Codex · Your CLI login · 5-hour 38%</main>",
    );
    const path = join(out, "usage.png");
    await usageScreenshot(page, path, scrubber());
    const colours = await page.evaluate(
      async (encoded) => {
        const picture = new Image();
        picture.src = `data:image/png;base64,${encoded}`;
        await picture.decode();
        const canvas = document.createElement("canvas");
        canvas.width = picture.width;
        canvas.height = picture.height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("No canvas");
        context.drawImage(picture, 0, 0);
        const pixels = context.getImageData(0, 0, picture.width, picture.height).data;
        let privateRed = false,
          ink = false;
        for (let index = 0; index < pixels.length; index += 4) {
          privateRed ||=
            pixels[index] === 255 && pixels[index + 1] === 0 && pixels[index + 2] === 0;
          ink ||= pixels[index] === 0 && pixels[index + 1] === 0 && pixels[index + 2] === 0;
        }
        return { privateRed, ink };
      },
      (await readFile(path)).toString("base64"),
    );
    expect(colours).toEqual({ privateRed: false, ink: true });
    expect(await page.getByText("Private saved thread").isVisible()).toBe(true);
  } finally {
    await browser.close();
    await rm(out, { recursive: true, force: true });
  }
});
