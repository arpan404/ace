import { expect, it } from "vitest";
import { Client, BrowserOriginsClient } from "@ace/client";
import { DeviceId, ThreadId, ThreadView } from "@ace/protocol";
import { FakeDaemon, fakeTransport } from "./index.ts";

async function fixture(mode: "ask" | "auto-review" | "read-only" | "full-access" = "ask") {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  daemon.createThread({
    id: "thread",
    workspaceId: "workspace",
    title: "Browser origins",
    provider: "codex",
    permissionMode: mode,
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
it("fake clients can open an external site with human consent, list and revoke its thread grant", async () => {
  const f = await fixture();
  try {
    await f.client.request({ type: "browser.takeover", threadId: f.threadId });
    expect(
      await f.client.request({
        type: "browser.execute",
        threadId: f.threadId,
        command: { action: "navigate", url: "https://youtube.com", timeout: 1000 },
      }),
    ).toMatchObject({ ok: true });
    expect(
      await f.client.request({ type: "browser.origins.list", threadId: f.threadId }),
    ).toMatchObject({ ok: true, result: [{ origin: "https://youtube.com", grantedAt: 1000 }] });
    expect(
      await f.client.request({
        type: "browser.origins.revoke",
        threadId: f.threadId,
        origin: "https://youtube.com",
      }),
    ).toMatchObject({ ok: true, result: [] });
    expect(
      await f.client.request({
        type: "browser.origins.grant",
        threadId: f.threadId,
        origin: "https://allowed.example",
      }),
    ).toMatchObject({ ok: true, result: [{ origin: "https://allowed.example" }] });
    expect(
      await f.client.request({
        type: "browser.execute",
        threadId: f.threadId,
        command: { action: "navigate", url: "file:///etc/passwd", timeout: 1000 },
      }),
    ).toMatchObject({ ok: false, blocked: { reason: "invalid_origin" } });
  } finally {
    await f.client.close();
  }
});
it("the typed client grant API lists consent, grants exact origins, revokes and rejects invalid input", async () => {
  const f = await fixture();
  const origins = new BrowserOriginsClient(f.client);
  try {
    expect(await origins.list(f.threadId)).toEqual([]);
    expect(await origins.grant(f.threadId, "https://youtube.com")).toEqual([
      { origin: "https://youtube.com", grantedAt: 1000, scope: "thread" },
    ]);
    expect(await origins.list(f.threadId)).toEqual([
      { origin: "https://youtube.com", grantedAt: 1000, scope: "thread" },
    ]);
    expect(await origins.revoke(f.threadId, "https://youtube.com")).toEqual([]);
    expect(() => origins.grant(f.threadId, "https://user:password@youtube.com")).toThrow();
    expect(await origins.list(f.threadId)).toEqual([]);
  } finally {
    await f.client.close();
  }
});
it.each(["ask", "auto-review"] as const)(
  "fake %s navigation waits on the real client approval command and honors thread grants",
  async (mode) => {
    const f = await fixture(mode);
    try {
      const navigation = f.daemon.browser.navigateAgent("thread", "https://youtube.com");
      const interaction = Object.values(f.view().interactions)[0];
      if (!interaction) throw new Error("Missing approval");
      expect(f.view().thread.status.state).toBe("needs_you");
      expect(interaction.request).toMatchObject({
        title: "open https://youtube.com in the thread browser",
      });
      if (mode === "auto-review") expect(interaction.review?.decision).toBe("escalate");
      expect(
        await f.client.command({
          type: "interaction.resolve",
          interactionId: interaction.id,
          resolution: { kind: "approval", optionId: "allow_thread" },
        }),
      ).toMatchObject({ ok: true });
      await navigation;
      expect(f.daemon.browser.view("thread")?.url).toBe("https://youtube.com/");
      await f.daemon.browser.navigateAgent("thread", "https://youtube.com/second");
      expect(f.daemon.browser.originsList("thread")).toMatchObject([
        { origin: "https://youtube.com" },
      ]);
      f.daemon.browser.originsRevoke("thread", "https://youtube.com");
      const failure = expect(
        f.daemon.browser.navigateAgent("thread", "https://youtube.com"),
      ).rejects.toMatchObject({ blocked: { reason: "denied" } });
      const pending = Object.values(f.view().interactions).find(
        (entry) => entry.state === "pending",
      );
      if (!pending) throw new Error("Missing approval after revoke");
      await f.client.command({
        type: "interaction.resolve",
        interactionId: pending.id,
        resolution: { kind: "approval", optionId: "deny" },
      });
      await failure;
    } finally {
      await f.client.close();
    }
  },
);
it("fake full access and a global allowlist open sites; read-only refuses them", async () => {
  for (const mode of ["full-access", "ask", "read-only"] as const) {
    const f = await fixture(mode);
    try {
      f.daemon.services.settings.seed({ "browser.allowedOrigins": ["https://youtube.com"] });
      if (mode === "read-only")
        await expect(
          f.daemon.browser.navigateAgent("thread", "https://youtube.com"),
        ).rejects.toMatchObject({ blocked: { reason: "read_only" } });
      else {
        await f.daemon.browser.navigateAgent(
          "thread",
          mode === "full-access" ? "https://new.example" : "https://youtube.com",
        );
        expect(Object.values(f.view().interactions)).toEqual([]);
        if (mode === "full-access") {
          expect(f.daemon.browser.originsList("thread")).toMatchObject([
            { origin: "https://new.example", scope: "page" },
          ]);
          f.daemon.browser.originsRevoke("thread", "https://new.example");
          expect(f.daemon.browser.originsList("thread")).toEqual([]);
        }
      }
    } finally {
      await f.client.close();
    }
  }
});

it("fake wire exposes tabs, dialogs, downloads and evaluate revocation", async () => {
  const f = await fixture();
  try {
    await f.client.request({ type: "browser.takeover", threadId: f.threadId });
    const opened = await f.client.request({
      type: "browser.tabs.open",
      threadId: f.threadId,
      url: "https://site.example/page",
    });
    expect(opened).toMatchObject({ ok: true });
    const view = f.daemon.browser.view(f.threadId),
      tabId = view?.activeTabId;
    if (!tabId) throw new Error("tab");
    expect(
      await f.client.request({ type: "browser.tabs.list", threadId: f.threadId }),
    ).toMatchObject({
      ok: true,
      result: [{ url: "about:blank" }, { tabId, url: "https://site.example/page" }],
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
    f.daemon.browser.evaluateGrant(f.threadId, {
      origin: "https://site.example",
      mode: "read-only",
      grantedAt: 1000,
    });
    expect(
      await f.client.request({ type: "browser.evaluate.grants.list", threadId: f.threadId }),
    ).toMatchObject({ ok: true, result: [{ mode: "read-only" }] });
    expect(
      await f.client.request({
        type: "browser.evaluate.grants.revoke",
        threadId: f.threadId,
        origin: "https://site.example",
      }),
    ).toMatchObject({ ok: true, result: [] });
    await f.client.request({ type: "browser.tabs.close", threadId: f.threadId, tabId });
    expect(f.daemon.browser.tabsList(f.threadId)).toHaveLength(1);
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

it("fake once grants are listed for the page and expire at the next agent navigation", async () => {
  const f = await fixture();
  try {
    const first = f.daemon.browser.navigateAgent("thread", "https://first.example");
    const interaction = Object.values(f.view().interactions).find(
      (entry) => entry.state === "pending",
    );
    if (!interaction) throw new Error("approval");
    await f.client.command({
      type: "interaction.resolve",
      interactionId: interaction.id,
      resolution: { kind: "approval", optionId: "allow_once" },
    });
    await first;
    expect(
      await f.client.request({ type: "browser.origins.list", threadId: f.threadId }),
    ).toMatchObject({ ok: true, result: [{ origin: "https://first.example", scope: "page" }] });
    const next = f.daemon.browser.navigateAgent("thread", "https://second.example");
    const denied = expect(next).rejects.toMatchObject({ blocked: { reason: "denied" } });
    expect(f.daemon.browser.originsList("thread")).toEqual([]);
    const pending = Object.values(f.view().interactions).find((entry) => entry.state === "pending");
    if (!pending) throw new Error("approval");
    await f.client.command({
      type: "interaction.resolve",
      interactionId: pending.id,
      resolution: { kind: "approval", optionId: "deny" },
    });
    await denied;
  } finally {
    await f.client.close();
  }
});
it("typed browser client APIs follow tabs, downloads, dialogs, grants and private handback", async () => {
  const { BrowserFeaturesClient } = await import("@ace/client");
  const f = await fixture(),
    browser = new BrowserFeaturesClient(f.client);
  try {
    await browser.takeover(f.threadId, "shared");
    const first = (await browser.tabs(f.threadId))[0];
    if (!first) throw new Error("tab");
    const opened = await browser.openTab(f.threadId);
    if (!("activeTabId" in opened)) throw new Error("unexpected dialog");
    expect(opened.tabs).toHaveLength(2);
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
    f.daemon.browser.evaluateGrant(f.threadId, {
      origin: "https://site.example",
      mode: "read-only",
      grantedAt: 1000,
    });
    expect(await browser.evaluateGrants(f.threadId)).toMatchObject([
      { origin: "https://site.example" },
    ]);
    expect(await browser.revokeEvaluateGrant(f.threadId, "https://site.example")).toEqual([]);
    expect(await browser.closeTab(f.threadId, opened.activeTabId)).toMatchObject({ tabs: [first] });
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
