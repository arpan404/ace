import { expect, it } from "vitest";
import { Client, BrowserFeaturesClient } from "@ace/client";
import { DeviceId, ThreadId, ThreadView, type AccessMode } from "@ace/protocol";
import { FakeDaemon, fakeTransport } from "./index.ts";

async function fixture(mode: AccessMode = "auto-review") {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  daemon.createThread({
    id: "thread",
    workspaceId: "workspace",
    title: "Browser control",
    provider: "codex",
    access: mode,
  });
  daemon.apply("thread", [{ type: "turn.started", agent: "root", trigger: "user" }]);
  daemon.browser.drive("thread", { url: "about:blank" });
  let sequence = 0;
  const client = new Client({
    deviceId: DeviceId.parse("owner"),
    transport: () => fakeTransport(daemon),
    credential: async () => daemon.token,
    storage: {
      async load() {
        return null;
      },
      async save() {},
    },
    scheduler: { set: () => () => {} },
    random: () => 0,
    id: () => `id-${++sequence}`,
  });
  const ready = new Promise<void>((resolve) => {
    const stop = client.connectionState().subscribe(() => {
      if (client.state === "ready") {
        stop();
        resolve();
      }
    });
  });
  await client.start();
  await ready;
  const threadId = ThreadId.parse("thread");
  const view = () => ThreadView.parse(daemon.snapshot({ kind: "thread", threadId }));
  return { daemon, client, threadId, view };
}
it.each(["ask", "auto-review"] as const)(
  "a fake %s agent opens a never-seen site without asking, and never in a private tab",
  async (mode) => {
    const f = await fixture(mode);
    try {
      await f.daemon.browser.navigateAgent("thread", "https://never-seen.example/page");
      expect(f.daemon.browser.view(f.threadId)?.url).toBe("https://never-seen.example/page");
      expect(Object.values(f.view().interactions)).toEqual([]);
      const tabId = f.daemon.browser.view(f.threadId)?.activeTabId ?? "";
      await f.client.request({
        type: "browser.tabs.private",
        threadId: f.threadId,
        tabId,
        private: true,
      });
      await expect(
        f.daemon.browser.navigateAgent("thread", "https://other.example"),
      ).rejects.toThrow("human_private");
      expect(f.daemon.browser.view(f.threadId)?.url).toBe("https://never-seen.example/page");
      // Privacy is the person's choice, never a question the thread waits on.
      expect(Object.values(f.view().interactions)).toEqual([]);
    } finally {
      await f.client.close();
    }
  },
);

it("fake wire opens, shows and closes real tabs, and closing the last one closes the browser", async () => {
  const f = await fixture();
  try {
    const firstTabId = f.daemon.browser.view(f.threadId)?.activeTabId;
    if (!firstTabId) throw new Error("tab");
    const opened = await f.client.request({
      type: "browser.tabs.open",
      threadId: f.threadId,
      url: "https://site.example/page",
    });
    expect(opened).toMatchObject({ ok: true });
    const tabId = f.daemon.browser.view(f.threadId)?.activeTabId;
    if (!tabId) throw new Error("tab");
    expect(tabId).not.toBe(firstTabId);
    expect(
      await f.client.request({ type: "browser.tabs.list", threadId: f.threadId }),
    ).toMatchObject({
      ok: true,
      result: [
        { tabId: firstTabId, url: "about:blank" },
        { tabId, url: "https://site.example/page", openedBy: { kind: "human" } },
      ],
    });
    f.daemon.browser.dialogOpen(f.threadId, {
      tabId,
      dialogId: "prompt",
      type: "prompt",
      message: "Name",
    });
    expect(
      await f.client.request({
        type: "browser.dialog.answer",
        threadId: f.threadId,
        tabId,
        dialogId: "prompt",
        accept: true,
        promptText: "Ada",
      }),
    ).toMatchObject({ ok: true });
    expect(f.daemon.browser.view(f.threadId)?.pending_dialog).toBeUndefined();
    f.daemon.browser.downloadAdd(f.threadId, {
      tabId,
      downloadId: "file",
      filename: "sample.zip",
      mimeType: "application/zip",
      bytes: 12,
      flags: ["archive"],
      state: "complete",
    });
    expect(
      await f.client.request({ type: "browser.downloads.list", threadId: f.threadId }),
    ).toMatchObject({ ok: true, result: [{ filename: "sample.zip", flags: ["archive"] }] });
    expect(
      await f.client.request({ type: "browser.tabs.close", threadId: f.threadId, tabId }),
    ).toMatchObject({ ok: true, result: { activeTabId: firstTabId } });
    expect(
      await f.client.request({
        type: "browser.tabs.close",
        threadId: f.threadId,
        tabId: firstTabId,
      }),
    ).toMatchObject({ ok: true, result: { closed: true } });
    expect(f.daemon.browser.view(f.threadId)?.closed).toBe(true);
  } finally {
    await f.client.close();
  }
});

it("typed browser client APIs open, select, close and keep agents out of tabs", async () => {
  const f = await fixture(),
    browser = new BrowserFeaturesClient(f.client);
  try {
    const first = (await browser.tabs(f.threadId))[0];
    if (!first) throw new Error("tab");
    const opened = await browser.openTab(f.threadId, "https://site.example/page");
    if (!("activeTabId" in opened)) throw new Error("unexpected dialog");
    expect(opened.tabId).toBe(opened.activeTabId);
    expect(opened.activeTabId).not.toBe(first.tabId);
    expect(await browser.selectTab(f.threadId, first.tabId)).toMatchObject({
      activeTabId: first.tabId,
    });
    expect(await browser.keepPrivate(f.threadId, first.tabId, true)).toMatchObject({
      tabs: [{ tabId: first.tabId, private: true }, {}],
    });
    await expect(browser.keepPrivate(f.threadId, "missing", true)).rejects.toMatchObject({
      code: "daemon",
    });
    expect(await browser.closeTab(f.threadId, opened.activeTabId)).toMatchObject({
      activeTabId: first.tabId,
    });
  } finally {
    await f.client.close();
  }
});

it("an agent's new tab joins the strip without taking the view from a person who picked one", async () => {
  const f = await fixture();
  try {
    const first = f.daemon.browser.view(f.threadId)?.activeTabId;
    if (!first) throw new Error("tab");
    await f.client.request({ type: "browser.tabs.select", threadId: f.threadId, tabId: first });
    const second = f.daemon.browser.tabOpen(f.threadId, "https://shop.example/cart", {
      agentId: "worker",
      label: "checkout",
    });
    expect(f.daemon.browser.view(f.threadId)?.activeTabId).toBe(first);
    expect(
      await f.client.request({ type: "browser.tabs.list", threadId: f.threadId }),
    ).toMatchObject({
      ok: true,
      result: [
        { tabId: first },
        {
          tabId: second,
          label: "checkout",
          openedBy: { kind: "agent", agentId: "worker" },
          inUse: { kind: "agent", agentId: "worker" },
        },
      ],
    });
  } finally {
    await f.client.close();
  }
});

it("the person's input reaches a tab an agent is using, with no control to take", async () => {
  const f = await fixture();
  try {
    f.daemon.browser.agentWorks(f.threadId, { agentId: "worker", pointer: { x: 10, y: 20 } });
    const tabId = f.daemon.browser.view(f.threadId)?.activeTabId;
    expect(
      await f.client.request({
        type: "browser.input",
        threadId: f.threadId,
        ...(tabId ? { tabId } : {}),
        input: { kind: "key", event: "keyDown", key: "a", text: "a", modifiers: 0 },
      }),
    ).toMatchObject({ ok: true });
    expect(f.daemon.browser.inputs).toMatchObject([
      { threadId: "thread", tabId, input: { kind: "key", key: "a" } },
    ]);
    expect(f.daemon.browser.tab(f.threadId)).toMatchObject({
      inUse: { kind: "agent", agentId: "worker" },
      pointer: { x: 10, y: 20 },
    });
  } finally {
    await f.client.close();
  }
});
