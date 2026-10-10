import { chromium, type CDPSession, type Page } from "@playwright/test";
import { pageMemory, reportDOM } from "@ace/web-perf";
import { afterEach, beforeEach, expect, inject, test, vi } from "vitest";

// Expected rejected samples must not look like real benchmark failures.
beforeEach(() => vi.spyOn(process.stdout, "write").mockImplementation(() => true));
afterEach(() => vi.restoreAllMocks());

async function withDOM(run: (page: Page, cdp: CDPSession) => Promise<void>) {
  const browser = await chromium.launch({ executablePath: inject("chromiumExecutable") });
  try {
    const page = await browser.newPage();
    await page.setContent("<main hidden></main>");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("HeapProfiler.enable");
    await run(page, cdp);
  } finally {
    await browser.close();
  }
}

test("detached churn passes but mounting 1000 extra hidden nodes fails the DOM gate", async () => {
  await withDOM(async (page, cdp) => {
    await page.evaluate(() => {
      const main = document.querySelector("main");
      if (!main) throw new Error("missing fixture root");
      for (let i = 0; i < 700; i++) main.append(document.createElement("div"));
    });
    for (let round = 0; round < 3; round++) {
      await page.evaluate(() => {
        const churn = document.createElement("section");
        for (let i = 0; i < 5_000; i++) churn.append(document.createElement("div"));
        document.body.append(churn);
        churn.remove();
        // Keep detached nodes alive so GC timing cannot decide the test result.
        Object.assign(globalThis, { aceDetachedFixture: churn });
      });
      const sample = await pageMemory(cdp);
      expect(sample.nodes).toBe(705);
      expect(sample.chromeNodes).toBeGreaterThan(5_000);
      expect(reportDOM(sample, 1_500)).toBe(true);
    }
    await page.evaluate(() => {
      const main = document.querySelector("main");
      if (!main) throw new Error("missing fixture root");
      for (let i = 0; i < 1_000; i++) main.append(document.createElement("div"));
    });
    const regression = await pageMemory(cdp);
    expect(regression.nodes).toBe(1_705);
    expect(reportDOM(regression, 1_500)).toBe(false);
    await page.evaluate(() => document.querySelector("main")?.replaceChildren());
    expect(reportDOM(await pageMemory(cdp), 1_500)).toBe(true);
  });
});

test("text, comments and open shadow trees contribute to the live DOM budget", async () => {
  await withDOM(async (page, cdp) => {
    await page.evaluate(() => {
      const main = document.querySelector("main");
      if (!main) throw new Error("missing fixture root");
      main.append(document.createTextNode("text"), document.createComment("comment"));
      const shadow = main.attachShadow({ mode: "open" });
      for (let i = 0; i < 1_500; i++) shadow.append(document.createTextNode("shadow text"));
    });
    const sample = await pageMemory(cdp);
    expect(sample.nodes).toBe(1_508);
    expect(reportDOM(sample, 1_500)).toBe(false);
  });
});

test("1500 attached nodes pass and one more mounted node fails", async () => {
  await withDOM(async (page, cdp) => {
    await page.evaluate(() => {
      const main = document.querySelector("main");
      if (!main) throw new Error("missing fixture root");
      for (let i = 0; i < 1_495; i++) main.append(document.createElement("div"));
    });
    const boundary = await pageMemory(cdp);
    expect(boundary.nodes).toBe(1_500);
    expect(reportDOM(boundary, 1_500)).toBe(true);
    await page.evaluate(() => document.body.append(document.createElement("div")));
    expect(reportDOM(await pageMemory(cdp), 1_500)).toBe(false);
  });
});
