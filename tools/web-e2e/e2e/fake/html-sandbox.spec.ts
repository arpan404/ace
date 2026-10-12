import { createServer } from "node:http";
import { test, expect } from "@playwright/test";
import { visualizationUrl, visualizationWindow } from "@ace/html";

/** These browser behavior guards are deliberately left for merge-time execution. */
test("interactive HTML cannot read its parent, navigate out, open a popup or send network requests", async ({
  page,
}) => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    if (request.url !== "/" && request.url !== "/favicon.ico") requests.push(request.url ?? "");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; frame-src data:",
    );
    response.end("<!doctype html><html><body><h1>Private app</h1></body></html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await page.goto(origin);
    await page.evaluate(() => {
      localStorage.setItem("daemon-token", "private");
      document.cookie = "app-cookie=private";
    });
    const html = `<!doctype html><html><body><p id="result">pending</p><script>
      const failures = [];
      for (const read of [() => parent.document.body, () => top.document.body, () => top.localStorage.getItem('daemon-token'), () => document.cookie]) {
        try { read(); failures.push('parent access'); } catch {}
      }
      try { top.location.href = '${origin}/top-navigation'; } catch {}
      if (window.open('${origin}/popup')) failures.push('popup opened');
      fetch('${origin}/fetch').catch(() => {});
      try { navigator.sendBeacon('${origin}/beacon', 'private'); } catch {}
      const image = new Image(); image.src = '${origin}/image'; document.body.append(image);
      const style = document.createElement('style'); style.textContent = 'body{background-image:url(${origin}/css)}'; document.head.append(style);
      try { new WebSocket('${origin.replace("http:", "ws:")}/socket'); } catch {}
      try { new Worker('${origin}/worker'); } catch {}
      if (typeof RTCPeerConnection !== 'undefined') failures.push('WebRTC available');
      const descendant = document.createElement('iframe');
      try { descendant.srcdoc = '<script>new RTCPeerConnection()<'+ '/script>'; failures.push('nested document allowed'); } catch {}
      document.body.append(descendant);
      document.getElementById('result').textContent = failures.length ? failures.join(',') : 'isolated and interactive';
      location.replace('${origin}/frame-navigation');
    </script></body></html>`;
    const url = visualizationUrl(html, { foreground: "rgb(0, 0, 0)" });
    await page.evaluate((src) => {
      const frame = document.createElement("iframe");
      frame.title = "Published chart";
      frame.setAttribute("sandbox", "allow-scripts");
      frame.src = src;
      document.body.append(frame);
    }, url);
    const child = page.frameLocator('iframe[title="Published chart"]').frameLocator("iframe");
    await expect(child.locator("#result")).toHaveText("isolated and interactive");
    await expect(page).toHaveURL(`${origin}/`);
    expect(requests).toEqual([]);
    expect(page.context().pages()).toHaveLength(1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("opening an exported visualization preserves its sandbox and inline interactions", async ({
  page,
}) => {
  await page.setContent(
    visualizationWindow(
      '<!doctype html><html><body><button onclick="this.textContent=42">Count</button></body></html>',
      {},
    ),
  );
  const button = page
    .frameLocator("iframe")
    .frameLocator("iframe")
    .getByRole("button", { name: "Count" });
  await button.click();
  await expect(button).toHaveText("42");
});
