import { createServer, type ServerResponse } from "node:http";
import { describe, expect, it, onTestFinished } from "vitest";
import { defaultTabLifecycle } from "./tab-lifecycle.ts";
import { executablePath, fixture } from "./test-support.ts";

/** ace's Chrome with a lifecycle timer the test fires, at a time the test sets. */
async function idleTabs() {
  const clock = { now: 0 };
  const ticks: (() => void)[] = [];
  const f = await fixture({
    now: () => clock.now,
    tabLifecycle: {
      policy: defaultTabLifecycle,
      every: 60_000,
      set: (_delay, work) => {
        ticks.push(work);
        return () => {};
      },
    },
  });
  const tab = f.service.state("thread").activeTabId;
  if (!tab) throw new Error("No tab");
  const lifecycle = () => f.service.state("thread").tabs?.find((entry) => entry.tabId === tab);
  /** Hours pass with the tab untouched, then the lifecycle timer looks. */
  const idleFor = (milliseconds: number) => {
    clock.now += milliseconds;
    ticks.shift()?.();
  };
  return { f, tab, lifecycle, idleFor };
}

/** A page with a download that keeps arriving until the test ends. */
async function slowDownload() {
  const held: ServerResponse[] = [];
  const server = createServer((request, response) => {
    if (request.url === "/big.bin") {
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": "attachment; filename=big.bin",
        "Content-Length": String(64 * 1024 * 1024),
      });
      response.write(Buffer.alloc(64 * 1024));
      held.push(response);
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end('<a href="/big.bin" download>Big download</a>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(async () => {
    for (const response of held) response.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server address missing");
  return `http://127.0.0.1:${address.port}/`;
}

describe.skipIf(!executablePath)("idle tabs in ace's Chrome", () => {
  it("a tab idle past the discard threshold is dropped and reopens at its address, its page state lost", async () => {
    const { f, tab, lifecycle, idleFor } = await idleTabs();
    await f.execute({ action: "navigate", url: `${f.url}/kept`, tabId: tab });
    await f.execute({ action: "evaluate", tabId: tab, expression: "window.marker = 'before'" });
    // Another tab takes the view, so this one is idle and unseen.
    await f.execute({ action: "tabs", operation: "open" });

    idleFor(defaultTabLifecycle.discardAfterMs + 1);
    await expect.poll(() => lifecycle()?.lifecycle).toBe("discarded");
    expect(lifecycle()?.url).toBe(`${f.url}/kept`);

    expect(
      await f.execute({
        action: "evaluate",
        tabId: tab,
        expression: "[location.pathname, typeof window.marker]",
      }),
    ).toEqual(["/kept", "undefined"]);
    expect(lifecycle()).toMatchObject({ lifecycle: "live", pageStateLost: true });
  }, 60_000);

  it("a tab with a download still arriving is neither frozen nor discarded", async () => {
    const { f, tab, lifecycle, idleFor } = await idleTabs();
    await f.execute({ action: "navigate", url: await slowDownload(), tabId: tab });
    await f.execute({
      action: "evaluate",
      tabId: tab,
      expression: "document.querySelector('a').click()",
    });
    await expect
      .poll(() => f.service.downloadsList("thread").map((download) => download.state))
      .toEqual(["pending"]);
    await f.execute({ action: "tabs", operation: "open" });

    idleFor(defaultTabLifecycle.discardAfterMs + 1);
    // Give the lifecycle pass time to act, had it wanted to.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(lifecycle()?.lifecycle).toBe("live");
    expect(f.service.downloadsList("thread").map((download) => download.state)).toEqual([
      "pending",
    ]);
  }, 60_000);
});
