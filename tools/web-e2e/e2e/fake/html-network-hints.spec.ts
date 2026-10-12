import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, test } from "@playwright/test";
import { visualizationDocument, visualizationWindow } from "@ace/html";
import { resolverLookups } from "../../src/html-netlog.ts";

// Kept unrun during development. The positive control prevents a disabled browser resolver
// or Playwright's background-networking flag from making this guard pass without observation.
test("published and exported pages cannot resolve runtime network hints", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-html-dns-"));
  const netlog = join(root, "netlog.json");
  const suffix = `${randomUUID()}.ace-html.test`;
  const controlHost = `control.${suffix}`;
  const browser = await chromium.launch({
    ignoreDefaultArgs: ["--disable-background-networking"],
    args: [`--log-net-log=${netlog}`, "--net-log-capture-mode=Everything", "--no-proxy-server"],
  });
  try {
    for (const mode of ["render", "export"] as const) {
      const page = await browser.newPage();
      const html = `<!doctype html><html><head><script>
        const on = document.createElement('meta'); on.httpEquiv='x-dns-prefetch-control'; on.content='on'; document.head.append(on);
        for (const rel of ['dns-prefetch','preconnect','preload','prefetch','modulepreload']) {
          const link = document.createElement('link'); link.rel=rel; link.href='https://'+rel+'.${mode}.${suffix}/leak';
          if (rel==='preload') link.as='fetch';
          document.head.append(link);
        }
      </script></head><body style="min-height:431px"><h1>Static report</h1><button onclick="document.body.textContent='executed'">Details</button></body></html>`;
      const document =
        mode === "render" ? visualizationDocument(html, {}) : visualizationWindow(html, {});
      await page.setContent(document);
      const frame =
        mode === "render"
          ? page.frameLocator("iframe")
          : page.frameLocator("iframe").frameLocator("iframe");
      await expect(frame.getByRole("heading", { name: "Static report" })).toBeVisible();
      await frame.getByRole("button", { name: "Details" }).click();
      await expect(frame.getByRole("heading", { name: "Static report" })).toBeVisible();
      // The CSP hash must still allow the fixed resize bridge to run.
      const containing =
        mode === "render" ? page.locator("iframe") : page.frameLocator("iframe").locator("iframe");
      await expect(containing).toHaveCSS("height", "431px");
      // Give any accidentally enabled speculative lookup the same observation window as the control.
      await page.waitForTimeout(1000);
      await page.close();
    }
    // A DNS-only request in an unprotected control document must reach the same resolver.
    const page = await browser.newPage();
    await page.setContent("<!doctype html><html><body>Resolver control</body></html>");
    await page.evaluate((host) => {
      const dns = document.createElement("link");
      dns.rel = "dns-prefetch";
      dns.href = `https://${host}`;
      document.head.append(dns);
      const connect = document.createElement("link");
      connect.rel = "preconnect";
      connect.href = `https://${host}`;
      document.head.append(connect);
    }, controlHost);
    // Network hints have no DOM completion event. Observe a bounded resolver settling period.
    await page.waitForTimeout(1000);
    await browser.close();
    const lookups = await resolverLookups(netlog);
    expect(lookups.some((host) => host.includes(controlHost))).toBe(true);
    expect(lookups.filter((host) => host.includes(suffix) && !host.includes(controlHost))).toEqual(
      [],
    );
  } finally {
    await browser.close();
    await rm(root, { recursive: true, force: true });
  }
});
