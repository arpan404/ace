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
      { origin: "https://youtube.com", grantedAt: 1000 },
    ]);
    expect(await origins.list(f.threadId)).toEqual([
      { origin: "https://youtube.com", grantedAt: 1000 },
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
      }
    } finally {
      await f.client.close();
    }
  }
});
