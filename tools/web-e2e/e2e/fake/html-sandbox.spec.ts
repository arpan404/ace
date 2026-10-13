import { createServer } from "node:http";
import { test, expect } from "@playwright/test";
import { visualizationUrl, visualizationWindow } from "@ace/html";

test("a published page's scripts run but cannot reach the app, navigate, open pop-ups or send requests", async ({
  page,
}) => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    if (request.url !== "/" && request.url !== "/favicon.ico") requests.push(request.url ?? "");
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
      for (const read of [() => parent.document.body, () => top.document.body, () => top.localStorage.getItem('daemon-token'), () => document.cookie, () => localStorage.length]) {
        try { read(); failures.push('parent or storage access'); } catch {}
      }
      try { top.location.href = '${origin}/top-navigation'; } catch {}
      if (window.open('${origin}/popup')) failures.push('popup opened');
      fetch('${origin}/fetch').catch(() => {});
      try { navigator.sendBeacon('${origin}/beacon', 'private'); } catch {}
      const image = new Image(); image.src = '${origin}/image'; document.body.append(image);
      const style = document.createElement('style'); style.textContent = 'body{background-image:url(${origin}/css)}'; document.head.append(style);
      try { new WebSocket('${origin.replace("http:", "ws:")}/socket'); } catch {}
      try { new Worker('${origin}/worker'); } catch {}
      try { eval('1'); failures.push('eval allowed'); } catch {}
      if (typeof RTCPeerConnection !== 'undefined') failures.push('WebRTC available');
      for (const name of ['iframe', 'link', 'object']) {
        try { document.createElement(name); failures.push(name + ' created'); } catch {}
      }
      document.body.insertAdjacentHTML('beforeend', '<link rel="prefetch" href="${origin}/markup"><b id="kept">kept</b>');
      if (document.querySelector('link')) failures.push('markup link kept');
      if (!document.getElementById('kept')) failures.push('markup dropped');
      document.getElementById('result').textContent = failures.length ? failures.join(',') : 'isolated and interactive';
      setTimeout(() => location.replace('${origin}/frame-navigation'), 100);
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
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => localStorage.getItem("daemon-token"))).toBe("private");
    await expect(page).toHaveURL(`${origin}/`);
    expect(requests).toEqual([]);
    expect(page.context().pages()).toHaveLength(1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("an exported visualization runs its handlers inside the same sandbox", async ({ page }) => {
  await page.setContent(
    visualizationWindow(
      '<!doctype html><html><body><button onclick="this.textContent=42">Count</button></body></html>',
      {},
    ),
  );
  const button = page.frameLocator("iframe").frameLocator("iframe").getByRole("button");
  await button.click();
  await expect(button).toHaveText("42");
});
