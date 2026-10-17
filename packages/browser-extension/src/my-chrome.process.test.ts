import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { BrowserService, UserChromeBackend, detectChromium, type BackendOpen } from "@ace/browser";
import { BrowserOpen } from "@ace/protocol";
import { connectedBrowser, until } from "./my-chrome-test-support.ts";

/** Chrome for Testing (ace's pinned build) when the run names one; any Chromium otherwise. */
const executable = process.env.ACE_CHROMIUM_PATH ?? (await detectChromium());
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup().catch(() => {});
}, 60_000);

async function fixtureSite() {
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    const title = request.url === "/mine" ? "My tab" : "Agent page";
    response.end(`<!doctype html><title>${title}</title><body>
      <button onclick="document.getElementById('out').textContent='Clicked'">Press me</button>
      <div id="out" role="status" aria-label="Result"></div></body>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const Snapshot = z.object({
  nodes: z.array(z.object({ ref: z.string().optional(), name: z.string() })),
});
const ref = (raw: unknown, name: string) => {
  const found = Snapshot.parse(raw).nodes.find((node) => node.name === name && node.ref)?.ref;
  if (!found) throw new Error(`No ref for ${name}`);
  return found;
};

describe.skipIf(!executable || process.platform === "win32")("Use my Chrome end to end", () => {
  test("an agent drives its own tab in the person's browser through daemon, host and extension", async () => {
    const browser = await connectedBrowser(executable ?? "", cleanups);
    const site = await fixtureSite();
    const backend = new UserChromeBackend(browser.hub, process.platform);
    const service = new BrowserService({
      dataDir: join(browser.root, "service"),
      headlessBackend: backend,
      backendPreference: () => "headless",
    });
    cleanups.push(() => service.close());
    const state = await service.open({ threadId: "thread", workspaceId: "workspace" });
    expect(state.backend).toBe("user");
    await service.execute("thread", { action: "navigate", url: `${site}/agent` });
    const before = await service.execute("thread", { action: "snapshot" });
    await service.execute("thread", { action: "click", ref: ref(before, "Press me") });
    expect(
      await service.execute("thread", {
        action: "evaluate",
        expression: "document.getElementById('out').textContent",
      }),
    ).toBe("Clicked");
    const shot = z
      .object({ path: z.string() })
      .parse(await service.execute("thread", { action: "screenshot" }));
    expect((await readFile(shot.path)).subarray(0, 4)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    // The person sees the agent's tab, labelled as the agent's, while it is controlled.
    const [connection] = browser.hub.connections();
    expect(connection?.tabs).toEqual([
      expect.objectContaining({ access: "agent", attached: true, url: `${site}/agent` }),
    ]);
    // Ending the thread's browser closes the agent's tab in the person's browser.
    await service.closeThread("thread", { kind: "human", connectionId: "test" });
    await until(
      async () => !(await browser.chrome.targets()).some((t) => t.url === `${site}/agent`),
      "the agent tab to close",
    );
  }, 120_000);

  test("only a tab the person shared can be claimed, cookies stay out of reach, and un-sharing ends control", async () => {
    const browser = await connectedBrowser(executable ?? "", cleanups);
    const site = await fixtureSite();
    const backend = new UserChromeBackend(browser.hub, process.platform);
    await browser.chrome.send("Target.createTarget", { url: `${site}/mine` });
    await browser.chrome.send("Target.createTarget", { url: `${site}/private` });
    const tabIds = z.record(z.string(), z.number()).parse(
      await browser.asPerson(`chrome.tabs.query({}).then((tabs) =>
        Object.fromEntries(tabs.map((tab) => [new URL(tab.url || "about:blank").pathname, tab.id])))`),
    );
    const mine = tabIds["/mine"] ?? -1;
    const other = tabIds["/private"] ?? -1;
    await browser.asPerson(`chrome.runtime.sendMessage({ kind: "share", tabId: ${mine} })`);
    await until(() => backend.sharedTabs().length === 1, "the shared tab to reach ace");
    const [shared] = backend.sharedTabs();
    expect(shared?.tab).toEqual(expect.objectContaining({ title: "My tab", access: "shared" }));
    const connectionId = shared?.connectionId ?? "";
    const lost: string[] = [];
    const lifetime = new AbortController();
    cleanups.push(async () => lifetime.abort());
    const request: BackendOpen = {
      options: BrowserOpen.parse({ threadId: "shared-thread", workspaceId: "workspace" }),
      profileDir: browser.root,
      signal: lifetime.signal,
      allowed: async () => true,
      navigation: () => {},
      log: () => {},
      lost: (reason) => lost.push(reason),
    };
    await expect(backend.claim(request, { connectionId, tabId: other })).rejects.toThrow(
      /not shared/,
    );
    const session = await backend.claim(request, { connectionId, tabId: mine });
    expect(
      await session.cdp.send("Runtime.evaluate", {
        expression: "document.title",
        returnByValue: true,
      }),
    ).toEqual(expect.objectContaining({ result: expect.objectContaining({ value: "My tab" }) }));
    await expect(session.cdp.send("Network.getAllCookies")).rejects.toThrow(/does not allow/);
    await expect(session.navigate("chrome://settings", 10_000)).rejects.toThrow(/can't open/);
    await browser.asPerson(`chrome.runtime.sendMessage({ kind: "unshare", tabId: ${mine} })`);
    await until(() => lost.length === 1, "the session to learn the tab was un-shared");
    expect(lost).toEqual(["You stopped sharing this tab"]);
    await expect(session.cdp.send("Runtime.evaluate", { expression: "1" })).rejects.toThrow();
    // The person's tab is still open: ace only let go of it.
    expect((await browser.chrome.targets()).some((t) => t.url === `${site}/mine`)).toBe(true);
  }, 120_000);
});
