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
  "a fake %s agent opens a never-seen site without asking, and not while a person holds the browser",
  async (mode) => {
    const f = await fixture(mode);
    try {
      await f.daemon.browser.navigateAgent("thread", "https://never-seen.example/page");
      expect(f.daemon.browser.view(f.threadId)?.url).toBe("https://never-seen.example/page");
      expect(Object.values(f.view().interactions)).toEqual([]);
      await f.client.request({ type: "browser.takeover", threadId: f.threadId, mode: "private" });
      await expect(
        f.daemon.browser.navigateAgent("thread", "https://other.example"),
      ).rejects.toThrow("Browser controlled by human");
      expect(f.daemon.browser.view(f.threadId)?.url).toBe("https://never-seen.example/page");
    } finally {
      await f.client.close();
    }
  },
);

it("fake wire reuses the browser page, refuses its final close and exposes dialogs and downloads", async () => {
  const f = await fixture();
  try {
    await f.client.request({ type: "browser.takeover", threadId: f.threadId });
    const firstTabId = f.daemon.browser.view(f.threadId)?.activeTabId;
    if (!firstTabId) throw new Error("tab");
    const opened = await f.client.request({
      type: "browser.tabs.open",
      threadId: f.threadId,
      url: "https://site.example/page",
    });
    expect(opened).toMatchObject({ ok: true });
    const view = f.daemon.browser.view(f.threadId),
      tabId = view?.activeTabId;
    if (!tabId) throw new Error("tab");
    expect(tabId).toBe(firstTabId);
    expect(
      await f.client.request({ type: "browser.tabs.list", threadId: f.threadId }),
    ).toMatchObject({
      ok: true,
      result: [{ tabId, url: "https://site.example/page" }],
    });
    f.daemon.browser.dialogOpen(f.threadId, {
      tabId,
      dialogId: "prompt",
      type: "prompt",
      message: "Name",
    });
    expect(f.daemon.browser.view(f.threadId)?.pending_dialog?.message).toBe("Name");
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
    ).toMatchObject({ ok: false });
    expect(
      await f.client.request({ type: "browser.tabs.list", threadId: f.threadId }),
    ).toMatchObject({
      ok: true,
      result: [{ tabId, url: "https://site.example/page" }],
    });
  } finally {
    await f.client.close();
  }
});
it("fake private disconnect waits for a new takeover and explicit handback", async () => {
  const f = await fixture();
  try {
    await f.client.request({ type: "browser.takeover", threadId: f.threadId, mode: "private" });
    expect(f.view().thread.status.state).toBe("needs_you");
    expect(
      await f.client.request({ type: "browser.takeover", threadId: f.threadId, mode: "shared" }),
    ).toMatchObject({ ok: false });
    const owner = f.daemon.browser.view(f.threadId)?.owner;
    if (!owner) throw new Error("owner");
    f.daemon.browser.disconnect(owner);
    expect(f.view().thread.status.state).toBe("needs_you");
    const privateGate = Object.values(f.view().interactions).find(
      (entry) =>
        entry.state === "pending" && entry.raw.some((raw) => raw.type === "ace.browser.private"),
    );
    if (!privateGate) throw new Error("private gate");
    expect(
      await f.client.command({
        type: "interaction.resolve",
        interactionId: privateGate.id,
        resolution: { kind: "plan_review", decision: "approve" },
      }),
    ).toMatchObject({ ok: false, error: "private_handback_required" });
    expect(f.view().thread.status.state).toBe("needs_you");
    expect(f.daemon.browser.view(f.threadId)).toMatchObject({
      controller: "none",
      status: "paused",
      takeoverMode: "private",
    });
    await f.client.request({ type: "browser.takeover", threadId: f.threadId, mode: "private" });
    expect(
      await f.client.request({ type: "browser.handback", threadId: f.threadId }),
    ).toMatchObject({ ok: true });
    expect(f.daemon.browser.view(f.threadId)).toMatchObject({
      controller: "agent",
      status: "ready",
      takeoverMode: "shared",
    });
  } finally {
    await f.client.close();
  }
});

it("typed browser client APIs follow tabs, downloads, dialogs and private handback", async () => {
  const f = await fixture(),
    browser = new BrowserFeaturesClient(f.client);
  try {
    await browser.takeover(f.threadId, "shared");
    const first = (await browser.tabs(f.threadId))[0];
    if (!first) throw new Error("tab");
    const opened = await browser.openTab(f.threadId, "https://site.example/page");
    if (!("activeTabId" in opened)) throw new Error("unexpected dialog");
    expect(opened.activeTabId).toBe(first.tabId);
    expect(opened.tabs).toEqual([{ ...first, url: "https://site.example/page" }]);
    expect(await browser.openTab(f.threadId)).toEqual(opened);
    expect(await browser.switchTab(f.threadId, first.tabId)).toMatchObject({
      activeTabId: first.tabId,
    });
    f.daemon.browser.dialogOpen(f.threadId, {
      dialogId: "client-dialog",
      tabId: first.tabId,
      type: "prompt",
      message: "Client answer",
    });
    const dialog = f.daemon.browser.view(f.threadId)?.pending_dialog;
    if (!dialog) throw new Error("dialog");
    expect(
      await browser.answerDialog(f.threadId, dialog.tabId, dialog.dialogId, true, "answered"),
    ).toEqual({ ok: true });
    expect(f.daemon.browser.view(f.threadId)?.pending_dialog).toBeUndefined();
    expect(await browser.downloads(f.threadId)).toEqual([]);
    await expect(browser.closeTab(f.threadId, opened.activeTabId)).rejects.toMatchObject({
      code: "daemon",
    });
    expect(await browser.tabs(f.threadId)).toEqual(opened.tabs);
    expect(await browser.takeover(f.threadId, "private")).toMatchObject({
      takeoverMode: "private",
      controller: "human",
    });
    expect(await browser.handback(f.threadId)).toMatchObject({
      takeoverMode: "shared",
      controller: "agent",
    });
  } finally {
    await f.client.close();
  }
});
