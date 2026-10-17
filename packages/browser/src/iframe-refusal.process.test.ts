import { createServer } from "node:http";
import { chromium } from "playwright-core";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import type { ContextLauncher } from "./io.ts";
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
function launcher(
  wrap: (send: (method: string, params?: object) => Promise<unknown>) => typeof send = (send) =>
    send,
): ContextLauncher {
  return async (profile, options) => {
    const context = await chromium.launchPersistentContext(profile, {
      ...options,
      args: [
        ...(options?.args ?? []),
        "--site-per-process",
        "--host-resolver-rules=MAP *.test 127.0.0.1",
      ],
    });
    const attach = context.newCDPSession.bind(context);
    context.newCDPSession = async (page) => {
      const cdp = await attach(page);
      const send = cdp.send.bind(cdp) as (method: string, params?: object) => Promise<unknown>;
      Object.assign(cdp, { send: wrap(send) });
      return cdp;
    };
    return context;
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
    const f = await fixture({ launchContext: launcher() });
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
      launchContext: launcher((send) => async (method, params) => {
        const message = z.object({ message: z.string() }).safeParse(params);
        if (
          method === "Target.sendMessageToTarget" &&
          message.success &&
          message.data.message.includes('"Fetch.enable"') &&
          failed++ === 0
        )
          throw new Error("Injected iframe setup failure");
        return send(method, params);
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
