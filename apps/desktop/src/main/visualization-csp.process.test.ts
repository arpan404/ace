import { createServer } from "node:http";
import { chromium, type Browser, type Page } from "playwright-core";
import { expect, inject, it } from "vitest";
import { visualizationUrl } from "@ace/html";
import { packagedPolicy } from "./csp.ts";

const appBackground = [17, 17, 17];
const chart = `<!doctype html><html><head><title>Glacier</title></head><body>
<p style="color:#ff6600;margin:0">Glacier mass loss</p>
<svg width="200" height="100" role="img" aria-label="Two bars">
  <rect x="0" y="0" width="80" height="100" fill="#33aa77"/>
  <rect x="100" y="40" width="80" height="60" fill="#3377aa"/>
</svg></body></html>`;

/** Reads one screenshot pixel by decoding the PNG in a policy-free page. */
async function pixel(browser: Browser, page: Page, x: number, y: number): Promise<number[]> {
  const png = (await page.screenshot({ clip: { x, y, width: 1, height: 1 } })).toString("base64");
  const decoder = await browser.newPage();
  try {
    return await decoder.evaluate(async (source) => {
      const image = new Image();
      image.src = `data:image/png;base64,${source}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("No 2D context");
      context.drawImage(image, 0, 0);
      return Array.from(context.getImageData(0, 0, 1, 1).data.subarray(0, 3));
    }, png);
  } finally {
    await decoder.close();
  }
}

it("a chat visualization renders its text and SVG under the packaged renderer's CSP on the dark theme", async () => {
  const index = '<!doctype html><html><head><script>document.title="ace"</script></head></html>';
  const policy = packagedPolicy({ index, daemonOrigins: [], dynamicDaemons: false });
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-security-policy": policy, "content-type": "text/html" });
    response.end(
      `<!doctype html><html style="color-scheme:dark;background:rgb(${appBackground.join(",")})"><body style="margin:0"></body></html>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No listener");
  const browser = await chromium.launch({
    executablePath: inject("chromiumExecutable"),
    headless: true,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 400 } });
    await page.goto(`http://127.0.0.1:${address.port}/`);
    const source = visualizationUrl(chart, { colorScheme: "dark", foreground: "rgb(240,240,240)" });
    await page.evaluate((src) => {
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts");
      frame.style.cssText = "display:block;border:0;width:600px;height:320px";
      frame.src = src;
      document.body.append(frame);
    }, source);

    const content = page.frameLocator("iframe").frameLocator("iframe");
    await content.getByText("Glacier mass loss").waitFor({ timeout: 10_000 });
    expect(await content.locator("svg rect").count()).toBe(2);
    // The resize bridges ran: the page frame took the authored content's height.
    const pageFrame = page.frameLocator("iframe").locator("iframe");
    await expect
      .poll(() => pageFrame.evaluate((frame: HTMLElement) => frame.style.height))
      .toMatch(/^\d+px$/);

    expect(await pixel(browser, page, 40, 60)).toEqual([51, 170, 119]);
    // Empty space inside the frame shows the app background, not a light canvas.
    expect(await pixel(browser, page, 590, 310)).toEqual(appBackground);
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
