import { createServer } from "node:http";
import { expect, it, onTestFinished } from "vitest";
import type { OriginPolicy } from "./policy.ts";
import { executablePath, fixture } from "./test-support.ts";

/**
 * A site (not loopback, so the origin policy applies) whose page registers a service worker
 * that calls home as soon as it runs.
 */
async function siteWithWorker() {
  const ran: string[] = [];
  const server = createServer((request, response) => {
    if (request.url === "/sw.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(
        "self.addEventListener('install', (event) => event.waitUntil(fetch('/sw-ran')));",
      );
      return;
    }
    if (request.url === "/sw-ran") {
      ran.push(request.url);
      response.end("ok");
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end("<p>worker page</p><script>navigator.serviceWorker.register('/sw.js')</script>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server address missing");
  const origin = `http://worker.test:${address.port}`;
  return {
    origin,
    ran,
    chrome: {
      args: [
        "--host-resolver-rules=MAP worker.test 127.0.0.1",
        // Service workers need a secure context; this test origin counts as one.
        `--unsafely-treat-insecure-origin-as-secure=${origin}`,
      ],
    },
  };
}
const workerScript: OriginPolicy = (request) => request.url.endsWith("/sw.js");

it.skipIf(!executablePath)(
  "a service worker the origin policy refuses never runs in ace's Chrome",
  async () => {
    const site = await siteWithWorker();
    const f = await fixture({
      chrome: site.chrome,
      originPolicy: async (request) => !(await workerScript(request)),
    });
    await f.service.execute("thread", { action: "navigate", url: `${site.origin}/` });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(site.ran).toEqual([]);
    expect(await f.evaluate("document.querySelector('p').textContent")).toBe("worker page");
  },
  60_000,
);

it.skipIf(!executablePath)(
  "a service worker the origin policy admits runs as it would in any browser",
  async () => {
    const site = await siteWithWorker();
    const f = await fixture({ chrome: site.chrome, originPolicy: () => true });
    await f.service.execute("thread", { action: "navigate", url: `${site.origin}/` });
    await expect.poll(() => site.ran, { timeout: 10_000 }).toEqual(["/sw-ran"]);
  },
  60_000,
);
