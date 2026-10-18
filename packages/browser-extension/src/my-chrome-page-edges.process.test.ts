import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";
import {
  BrowserService,
  UserChromeBackend,
  UserChromeTabsBackend,
  detectChromium,
} from "@ace/browser";
import { connectedBrowser, until } from "./my-chrome-test-support.ts";

const executable = process.env.ACE_CHROMIUM_PATH ?? (await detectChromium());
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup().catch(() => {});
}, 60_000);

async function site() {
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end("<!doctype html><title>Page</title><p>Page</p>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The person's Chrome (Chrome for Testing with ace for Chrome) as a thread's browser. */
async function personsChrome() {
  const browser = await connectedBrowser(executable ?? "", cleanups);
  const service = new BrowserService({
    dataDir: join(browser.root, "service"),
    headlessBackend: new UserChromeTabsBackend(
      new UserChromeBackend(browser.hub, process.platform),
    ),
    backendPreference: () => "headless",
    tabLifecycle: false,
  });
  cleanups.push(() => service.close());
  await service.open({ threadId: "thread", workspaceId: "workspace" });
  const muted = async (url: string) =>
    z
      .array(z.object({ url: z.string(), mutedInfo: z.object({ muted: z.boolean() }) }))
      .parse(await browser.asPerson("chrome.tabs.query({})"))
      .find((tab) => tab.url === url)?.mutedInfo.muted;
  return { browser, service, muted, origin: await site() };
}

describe.skipIf(!executable || process.platform === "win32")("Use my Chrome page edges", () => {
  test("an agent's tab opens muted, and the person turns its sound back on from ace", async () => {
    const { service, muted, origin } = await personsChrome();
    await service.execute("thread", { action: "navigate", url: `${origin}/agent` });
    expect(await muted(`${origin}/agent`)).toBe(true);
    await until(() => service.state("thread").tabs?.[0]?.muted === true, "ace to list it muted");
    const tabId = service.state("thread").tabs?.[0]?.tabId ?? "";
    await service.asPerson("thread", { kind: "mute", tabId, muted: false });
    expect(await muted(`${origin}/agent`)).toBe(false);
    await until(() => service.state("thread").tabs?.[0]?.muted === false, "ace to list it playing");
  }, 60_000);
});
