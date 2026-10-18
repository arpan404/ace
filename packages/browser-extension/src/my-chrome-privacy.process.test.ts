import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { BrowserService, UserChromeBackend, detectChromium } from "@ace/browser";
import { connectedBrowser } from "./my-chrome-test-support.ts";

const executable = process.env.ACE_CHROMIUM_PATH ?? (await detectChromium());
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup().catch(() => {});
}, 60_000);

/** A signed-in page: a readable cookie, saved storage and a same-origin frame. */
async function signedInSite() {
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    if (request.url === "/frame") return void response.end("<!doctype html><p>inner</p>");
    response.setHeader("Set-Cookie", "session=secret-cookie; Path=/");
    response.end(`<!doctype html><title>Account</title><body>
      <button onclick="document.getElementById('out').textContent='Clicked'">Press me</button>
      <div id="out"></div><iframe src="/frame"></iframe>
      <script>localStorage.setItem('token', 'secret-storage');</script></body>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function myChrome(storageReads: boolean) {
  const browser = await connectedBrowser(executable ?? "", cleanups);
  const site = await signedInSite();
  const service = new BrowserService({
    dataDir: join(browser.root, "service"),
    headlessBackend: new UserChromeBackend(browser.hub, process.platform),
    backendPreference: () => "headless",
    userChromeStorageReads: () => storageReads,
    agentCursor: { glideMs: 0 },
  });
  cleanups.push(() => service.close());
  await service.open({ threadId: "thread", workspaceId: "workspace" });
  await service.execute("thread", { action: "navigate", url: `${site}/` });
  const agent = (expression: string, mode: "read-only" | "unrestricted" = "unrestricted") =>
    service.execute("thread", { action: "evaluate", expression, mode }, { kind: "agent" });
  return { service, agent };
}

describe.skipIf(!executable || process.platform === "win32")("Use my Chrome privacy", () => {
  test("an agent's evaluate reads the page but not its cookies or storage", async () => {
    const { agent } = await myChrome(false);
    expect(await agent("document.title")).toBe("Account");
    for (const expression of [
      "document.cookie",
      "localStorage.getItem('token')",
      "sessionStorage.length",
      "Object.getOwnPropertyDescriptor(Document.prototype, 'cookie').get.call(document)",
      "window[0].document.cookie",
      "document.querySelector('iframe').contentDocument.cookie",
      "(() => { const frame = document.createElement('iframe'); document.body.append(frame); return frame.contentWindow.localStorage.getItem('token'); })()",
      "(() => { document.body.insertAdjacentHTML('beforeend', '<iframe></iframe>'); return window[1].document.cookie; })()",
    ])
      await expect(agent(expression), expression).rejects.toThrow(/cookies or site storage/);
    await expect(agent("document.cookie", "read-only")).rejects.toThrow();
  }, 120_000);

  test("the person can let agents read cookies and storage in their own browser", async () => {
    const { agent } = await myChrome(true);
    expect(await agent("document.cookie")).toContain("secret-cookie");
    expect(await agent("localStorage.getItem('token')")).toBe("secret-storage");
  }, 120_000);

  test("the agent's cursor is drawn in the person's own tab", async () => {
    const { service } = await myChrome(false);
    const snapshot = z
      .object({ nodes: z.array(z.object({ ref: z.string().optional(), name: z.string() })) })
      .parse(await service.execute("thread", { action: "snapshot" }, { kind: "agent" }));
    const button = snapshot.nodes.find((node) => node.name === "Press me")?.ref;
    await service.execute("thread", { action: "click", ref: button }, { kind: "agent" });
    expect(
      await service.execute(
        "thread",
        { action: "evaluate", expression: "document.querySelector('ace-agent-cursor') !== null" },
        { kind: "human", connectionId: "person" },
      ),
    ).toBe(true);
  }, 120_000);
});
