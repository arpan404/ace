import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, expect, it } from "vitest";
import { BrowserService, detectChromium } from "./index.ts";
import { chromeDesktop } from "./relay-chrome-test-support.ts";

const executablePath = await detectChromium();
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
}, 60_000);

const html = (response: ServerResponse, body: string) => {
  response.setHeader("Content-Type", "text/html");
  response.setHeader("Cache-Control", "no-store");
  response.end(`<!doctype html><title>Fixture</title><body>${body}</body>`);
};
/** A script after this one holds the document short of DOMContentLoaded for a while. */
const held = (tag: string) => `<script src="/held.js?${tag}"></script>`;
const Reached = z.object({ url: z.string() });

/** Pages that move on by themselves, served to ace's own Chromium or a desktop's native view. */
async function pages(backend: "headless" | "desktop") {
  const desktop =
    backend === "desktop" && executablePath ? await chromeDesktop(executablePath) : undefined;
  if (desktop) cleanups.push(desktop.close);
  const home = await mkdtemp(join(tmpdir(), "ace-nav-commit-"));
  let landings = 0;
  const slowRequested = Promise.withResolvers<void>();
  const server = createServer((request, response) => {
    const path = request.url ?? "/";
    if (path.startsWith("/held.js")) {
      setTimeout(() => {
        response.setHeader("Content-Type", "text/javascript");
        response.end("void 0");
      }, 1_500);
      return;
    }
    if (path === "/redirect") {
      response.writeHead(302, { location: "/landing" });
      response.end();
      return;
    }
    if (path === "/landing") {
      // The first visit loads itself again, as a site settling its address does.
      landings++;
      if (landings === 1)
        return html(response, `<script>location.replace(location.href)</script>${held("a")}`);
      return html(response, "<p>Settled</p>");
    }
    if (path === "/moves-on")
      return html(response, `<script>location.replace('/final')</script>${held("b")}`);
    if (path === "/final") return html(response, "<p>Final page</p>");
    if (path === "/no-content") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (path === "/slow") {
      slowRequested.resolve();
      setTimeout(() => html(response, "<p>Slow</p>"), 5_000);
      return;
    }
    html(response, "<p>Home</p>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  const url = `http://127.0.0.1:${address.port}`;
  const service = new BrowserService({
    dataDir: home,
    ...(executablePath ? { executablePath } : {}),
    ...(desktop ? { backendPreference: () => "embedded" as const } : {}),
  });
  if (desktop) desktop.attach(service.registerEmbedded(desktop.transport));
  cleanups.push(async () => {
    try {
      await service.close();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  });
  await service.open({ threadId: "thread", workspaceId: "workspace" });
  const execute = (command: unknown) => service.execute("thread", command);
  return {
    desktop,
    url,
    slowRequested: slowRequested.promise,
    /** A short wait, so a navigation that never counts as loaded fails well inside the test. */
    navigate: async (path: string) =>
      Reached.parse(await execute({ action: "navigate", url: url + path, timeout: 8_000 })).url,
    text: async () =>
      z
        .string()
        .parse(await execute({ action: "evaluate", expression: "document.body.innerText" }))
        .trim(),
  };
}

for (const backend of ["headless", "desktop"] as const) {
  it.skipIf(!executablePath)(
    `${backend}: a page that re-navigates itself right after loading counts as loaded`,
    async () => {
      const f = await pages(backend);
      expect(await f.navigate("/redirect")).toBe(`${f.url}/landing`);
      await expect.poll(f.text, { timeout: 10_000 }).toBe("Settled");
    },
    60_000,
  );

  it.skipIf(!executablePath)(
    `${backend}: a navigation the page replaces before its DOM is ready resolves with the final address`,
    async () => {
      const f = await pages(backend);
      expect(await f.navigate("/moves-on")).toBe(`${f.url}/final`);
      await expect.poll(f.text, { timeout: 10_000 }).toBe("Final page");
    },
    60_000,
  );

  it.skipIf(!executablePath)(
    `${backend}: a navigation that commits no document still fails and keeps the page`,
    async () => {
      const f = await pages(backend);
      await f.navigate("/");
      await expect(f.navigate("/no-content")).rejects.toThrow("net::ERR_ABORTED");
      expect(await f.text()).toBe("Home");
    },
    60_000,
  );
}

it.skipIf(!executablePath)(
  "a navigation the desktop view replaces resolves with the address the view committed",
  async () => {
    const f = await pages("desktop");
    await f.navigate("/");
    const navigation = f.navigate("/slow");
    // The person (or the desktop itself) loads another page while ace's is still on its way.
    await f.slowRequested;
    await f.desktop?.navigateView(`${f.url}/final`);
    expect(await navigation).toBe(`${f.url}/final`);
  },
  60_000,
);
