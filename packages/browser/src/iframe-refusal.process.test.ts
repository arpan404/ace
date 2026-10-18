import { createServer } from "node:http";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import type { CdpSend } from "./cdp-connection.ts";
import type { ChromeLaunch } from "./chrome-instance.ts";
import { executablePath, fixture } from "./test-support.ts";

/** Many sites on one local server: every `sN.test` host is its own site, so its own process. */
async function crossSitePages() {
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(request.url?.startsWith("/frame") ? "<p>frame</p>" : "<p>top page</p>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server address missing");
  return address.port;
}
function launcher(wrap: (send: CdpSend) => CdpSend = (send) => send): Partial<ChromeLaunch> {
  return {
    args: ["--site-per-process", "--host-resolver-rules=MAP *.test 127.0.0.1"],
    intercept: { send: wrap },
  };
}
const loadFrames = (port: number, count: number, wanted: number) => `new Promise(resolve => {
  let loaded = 0;
  for (let i = 0; i < ${count}; i++) {
    const frame = document.createElement('iframe');
    frame.src = 'http://s' + i + '.test:${port}/frame';
    frame.onload = () => { if (++loaded === ${wanted}) resolve(loaded); };
    document.body.append(frame);
  }
})`;

it.skipIf(!executablePath)(
  "a page with more cross-site iframes than the guard serves stays open and usable",
  async () => {
    const port = await crossSitePages();
    const f = await fixture({ chrome: launcher() });
    await f.service.execute("thread", { action: "navigate", url: `http://localhost:${port}/` });
    // The guard serves 64 isolated frames; the rest stay blank instead of closing the page.
    expect(await f.evaluate(loadFrames(port, 70, 64))).toBe(64);
    expect(await f.evaluate("document.querySelector('p').textContent")).toBe("top page");
    expect(await f.evaluate("document.querySelectorAll('iframe').length")).toBe(70);
    expect(f.service.state("thread")).toMatchObject({ status: "ready", closed: false });
  },
  90_000,
);

it.skipIf(!executablePath)(
  "page stays usable after an iframe's request guard cannot be set up",
  async () => {
    const port = await crossSitePages();
    let failed = 0;
    const f = await fixture({
      chrome: launcher((send) => async (method, params, sessionId) => {
        const message = z.object({ message: z.string() }).safeParse(params);
        if (
          method === "Target.sendMessageToTarget" &&
          message.success &&
          message.data.message.includes('"Fetch.enable"') &&
          failed++ === 0
        )
          throw new Error("Injected iframe setup failure");
        return send(method, params, sessionId);
      }),
    });
    await f.service.execute("thread", { action: "navigate", url: `http://localhost:${port}/` });
    // The refused frame never loads; its siblings and the page itself keep working.
    expect(await f.evaluate(loadFrames(port, 3, 2))).toBe(2);
    expect(failed).toBeGreaterThan(0);
    expect(await f.evaluate("document.querySelector('p').textContent")).toBe("top page");
    expect(f.service.state("thread")).toMatchObject({ status: "ready", closed: false });
  },
  90_000,
);
