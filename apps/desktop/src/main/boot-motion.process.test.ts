import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, expect, inject, it } from "vitest";
import { packagedPolicy } from "./csp.ts";

/*
 * The packaged window's first paint: the web app's real index.html under the policy the packaged
 * renderer serves it with. Its inline boot script sets the theme and motion attributes before the
 * app loads, so a policy whose hash no longer matches the file would freeze the boot mark and drop
 * the Reduce motion setting.
 */

let server: Server;
let origin = "";
let browser: Browser;

beforeAll(async () => {
  const index = await readFile(new URL("../../../web/index.html", import.meta.url), "utf8");
  const policy = packagedPolicy({ index, daemonOrigins: [], dynamicDaemons: false });
  server = createServer((request, response) => {
    if (request.url !== "/") {
      response.writeHead(404, { "content-security-policy": policy });
      response.end();
      return;
    }
    response.writeHead(200, { "content-security-policy": policy, "content-type": "text/html" });
    response.end(index);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No listener");
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ executablePath: inject("chromiumExecutable"), headless: true });
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

async function firstPaint(options: {
  reducedMotion: "reduce" | "no-preference";
  /** The appearance the app last applied, as it saves it for the next first paint. */
  stored?: { css: string; theme: string; reduceMotion: "system" | "on" | "off" };
}) {
  const context = await browser.newContext({ reducedMotion: options.reducedMotion });
  try {
    const page = await context.newPage();
    await page.addInitScript((stored) => {
      const violations: string[] = [];
      Object.assign(window, { violations });
      document.addEventListener("securitypolicyviolation", (event) =>
        violations.push(event.violatedDirective),
      );
      if (stored) localStorage.setItem("ace.boot-appearance", JSON.stringify(stored));
    }, options.stored);
    await page.goto(origin);
    return await page.evaluate(() => {
      const mark = document.querySelector("#boot .mark");
      return {
        violations: Reflect.get(window, "violations"),
        scheme: document.documentElement.getAttribute("data-scheme"),
        reduced: document.documentElement.hasAttribute("data-reduce-motion"),
        animations: mark?.getAnimations().filter((a) => a.playState === "running").length ?? 0,
        animationName: mark ? getComputedStyle(mark).animationName : "missing",
      };
    });
  } finally {
    await context.close();
  }
}

it("the boot script runs under the packaged policy and the mark breathes when the OS allows motion", async () => {
  const shown = await firstPaint({ reducedMotion: "no-preference" });
  expect(shown.violations).toEqual([]);
  // The boot script ran: it resolved the scheme and left motion on (System + OS off).
  expect(shown.scheme).toMatch(/^(dark|light)$/);
  expect(shown.reduced).toBe(false);
  expect(shown.animationName).not.toBe("none");
  expect(shown.animations).toBeGreaterThan(0);
});

it("the boot mark holds still when the OS asks for reduced motion under System", async () => {
  const shown = await firstPaint({ reducedMotion: "reduce" });
  expect(shown.reduced).toBe(true);
  expect(shown.animations).toBe(0);
});

it("Reduce motion Off keeps the boot mark moving even when the OS asks for reduced motion", async () => {
  const shown = await firstPaint({
    reducedMotion: "reduce",
    stored: { css: "", theme: "ace", reduceMotion: "off" },
  });
  expect(shown.reduced).toBe(false);
  expect(shown.animations).toBeGreaterThan(0);
});
