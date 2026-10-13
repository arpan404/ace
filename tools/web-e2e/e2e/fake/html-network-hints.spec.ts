import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, test } from "@playwright/test";
import { visualizationUrl, visualizationWindow } from "@ace/html";
import { resolverLookups } from "../../src/html-netlog.ts";

/** Every way a script can ask Chromium for a network hint, each tried on its own. */
function hintScript(suffix: string, label: string): string {
  return `
    const host = (rel) => 'https://' + rel + '.${label}.${suffix}/';
    const attempt = (run) => { try { run(); } catch {} };
    for (const rel of ['dns-prefetch','preconnect','preload','prefetch','modulepreload'])
      attempt(() => { const link = document.createElement('link'); link.rel = rel; link.href = host(rel); link.as = 'fetch'; document.head.append(link); });
    attempt(() => { const link = document.createElementNS('http://www.w3.org/1999/xhtml', 'link'); link.rel = 'dns-prefetch'; link.href = host('namespaced'); document.head.append(link); });
    attempt(() => document.head.insertAdjacentHTML('beforeend', '<link rel="dns-prefetch" href="' + host('markup') + '">'));
    attempt(() => { const doc = new DOMParser().parseFromString('<link rel="dns-prefetch" href="' + host('parser') + '">', 'text/html'); document.head.append(...doc.head.childNodes); });
    attempt(() => { customElements.define('x-hint', class extends HTMLLinkElement {}, { extends: 'link' }); const link = document.createElement('link', { is: 'x-hint' }); link.rel = 'dns-prefetch'; link.href = host('custom'); document.head.append(link); });
    attempt(() => { const frame = document.createElement('iframe'); document.documentElement.append(frame); const link = frame.contentDocument.createElement('link'); link.rel = 'dns-prefetch'; link.href = host('realm'); document.head.append(link); });
    addEventListener('DOMContentLoaded', () => {
      const count = document.createElement('p'); count.id = 'links'; count.textContent = 'links:' + document.querySelectorAll('link').length; document.body.append(count);
    });
  `;
}

// The web client has no session to lock (the desktop app does: visualization-isolation.ts), so
// the page bridge must refuse every known way a script makes a hint element. The control runs the
// same script in the same kind of sandboxed frame without the bridge, so the resolver is observed.
test("published and exported pages run scripts but cannot resolve runtime network hints", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-html-dns-"));
  const netlog = join(root, "netlog.json");
  const suffix = `${randomUUID()}.ace-html.test`;
  const page = (label: string) =>
    `<!doctype html><html><head><script>${hintScript(suffix, label)}</script></head><body style="min-height:431px"><h1>Report</h1><button onclick="this.textContent='ran'">Details</button></body></html>`;
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    if (request.url === "/export")
      response.end(visualizationWindow(page("export"), {}, "interactive"));
    else response.end("<!doctype html><html><body></body></html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  const origin = `http://127.0.0.1:${address.port}`;
  // Full Chromium: the headless shell never resolves hints, so it could not observe a leak.
  const browser = await chromium.launch({
    channel: "chromium",
    ignoreDefaultArgs: ["--disable-background-networking"],
    args: [`--log-net-log=${netlog}`, "--net-log-capture-mode=Everything", "--no-proxy-server"],
  });
  try {
    const tab = await browser.newPage();
    // As the web client renders it: an opaque sandboxed frame holding the visualization.
    await tab.goto(origin);
    await tab.evaluate(
      (src) => {
        const frame = document.createElement("iframe");
        frame.setAttribute("sandbox", "allow-scripts");
        frame.style.cssText = "width:600px;height:600px";
        frame.src = src;
        document.body.append(frame);
      },
      visualizationUrl(page("render"), {}, "interactive"),
    );
    const rendered = tab.frameLocator("iframe").frameLocator("iframe");
    await rendered.getByRole("button", { name: "Details" }).click();
    await expect(rendered.getByRole("button", { name: "ran" })).toBeVisible();
    // No hint element ever entered the page, by any route.
    await expect(rendered.locator("#links")).toHaveText("links:0");
    await expect(tab.frameLocator("iframe").locator("iframe")).toHaveCSS("height", "431px");

    // As a downloaded file opens it.
    const exported = await browser.newPage();
    await exported.goto(`${origin}/export`);
    const exportedPage = exported.frameLocator("iframe").frameLocator("iframe");
    await exportedPage.getByRole("button", { name: "Details" }).click();
    await expect(exportedPage.getByRole("button", { name: "ran" })).toBeVisible();
    await expect(exportedPage.locator("#links")).toHaveText("links:0");

    // Control: the same script in an unguarded sandboxed frame.
    const control = await browser.newPage();
    await control.goto(origin);
    await control.evaluate(
      (script) => {
        const frame = document.createElement("iframe");
        frame.setAttribute("sandbox", "allow-scripts");
        frame.srcdoc = `<!doctype html><html><head><script>${script}</script></head></html>`;
        document.body.append(frame);
      },
      hintScript(suffix, "control"),
    );
    // Network hints have no DOM completion event. Observe a bounded resolver settling period.
    await control.waitForTimeout(1500);
    await browser.close();
    const lookups = (await resolverLookups(netlog)).filter((host) => host.includes(suffix));
    // Playwright's Chromium resolves no DNS-only hints even for the control, so the observable
    // control is the fetch-backed hints; the DNS-only ones are covered by "links:0" above.
    expect(lookups.some((host) => host.includes("prefetch.control."))).toBe(true);
    expect(lookups.filter((host) => !host.includes(".control."))).toEqual([]);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
