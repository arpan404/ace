import { expect, it } from "vitest";
import { readyServices } from "./services/composition.ts";
import { originFixture } from "./browser-origin-test-support.ts";
import { BrowserOrigins } from "./browser-origins.ts";
import { BrowserService } from "@ace/browser";
import { FakeHeadless } from "@ace/browser/testing";

it("a human lease owner opens an external site, records consent, and the grant survives browser service and SQLite restart", async () => {
  const f = await originFixture();
  const owner = await f.client();
  const threadId = f.thread.id;
  expect(
    await owner.request({ type: "browser.takeover", requestId: "take", threadId }),
  ).toMatchObject({ ok: true });
  expect(
    await owner.request({
      type: "browser.execute",
      requestId: "visit",
      threadId,
      command: { action: "navigate", url: "https://youtube.com/watch?v=fixture" },
    }),
  ).toMatchObject({ ok: true, result: { url: "https://youtube.com/watch?v=fixture" } });
  expect(
    await owner.request({ type: "browser.origins.list", requestId: "list", threadId }),
  ).toMatchObject({ ok: true, result: [{ origin: "https://youtube.com", grantedAt: 1000 }] });
  await f.close();
  const restarted = await originFixture("ask", f.home);
  expect(await restarted.navigation()).toMatchObject({
    url: "https://youtube.com/watch?v=local-test",
  });
  expect(restarted.store.acquireThread(threadId).interactions).toEqual({});
  restarted.store.releaseThread(threadId);
});
it("the backend policy grants human main documents and allows temporary cross-origin resources", async () => {
  const f = await originFixture();
  f.browser.takeover(f.thread.id, "owner");
  const backend = f.headless.opens[0];
  if (!backend) throw new Error("Missing backend");
  expect(await backend.allowed("https://links.example/page", { navigation: true })).toBe(true);
  expect(await backend.allowed("https://redirect.example/final", { navigation: true })).toBe(true);
  expect(await backend.allowed("https://cdn.example/image.png")).toBe(true);
  expect(await backend.allowed("wss://socket.example/live")).toBe(true);
  expect(f.browser.originsList(f.thread.id).map((grant) => grant.origin)).toEqual([
    "https://links.example",
    "https://redirect.example",
  ]);
  f.browser.handback(f.thread.id, "owner");
  expect(await backend.allowed("https://cdn.example/image.png")).toBe(false);
  expect(await backend.allowed("wss://socket.example/live")).toBe(false);
  expect(await backend.allowed("wss://links.example/live")).toBe(true);
});
it("full access opens new origins without human work and keeps the allowance page-only", async () => {
  const f = await originFixture("full-access");
  expect(await f.navigation()).toMatchObject({ url: expect.stringContaining("youtube.com") });
  expect(f.browser.originsList(f.thread.id)).toMatchObject([
    { origin: "https://youtube.com", scope: "page" },
  ]);
  const backend = f.headless.opens[0];
  expect(await backend?.allowed("wss://youtube.com/live")).toBe(true);
  expect(await backend?.allowed("https://cdn.example/image")).toBe(true);
  expect(await backend?.allowed("wss://socket.example/live")).toBe(true);
  await f.navigation("https://other.example");
  f.store.appendEvents(f.thread.id, [
    { type: "thread.updated", permission: { override: "ask", effective: "ask", pending: false } },
  ]);
  expect(await backend?.allowed("wss://youtube.com/live")).toBe(false);
  expect(await backend?.allowed("wss://socket.example/live")).toBe(false);
  expect(await backend?.allowed("wss://other.example/live")).toBe(true);
});
it("read-only refuses agent navigation even to granted and loopback origins; human consent still works", async () => {
  const f = await originFixture("read-only");
  f.browser.originsGrant(f.thread.id, "https://youtube.com");
  for (const url of ["https://youtube.com", "http://localhost:1234"])
    await expect(f.navigation(url)).rejects.toMatchObject({
      blocked: { reason: "read_only", origin: url },
    });
  f.browser.takeover(f.thread.id, "owner");
  expect(
    await f.browser.execute(
      f.thread.id,
      { action: "navigate", url: "https://human.example" },
      { kind: "human", connectionId: "owner" },
    ),
  ).toMatchObject({ url: "https://human.example" });
});
it.each(["ask", "auto-review"] as const)(
  "%s requests the exact action and honors once, thread and denial decisions",
  async (mode) => {
    const f = await originFixture(mode);
    const opened = f.opened();
    const first = f.navigation();
    const interaction = await opened;
    expect(interaction.request).toMatchObject({
      title: "open https://youtube.com in the thread browser",
      options: [
        { id: "allow_once", label: "Allow once" },
        { id: "allow_thread", label: "Allow for this thread" },
        { id: "deny", label: "Deny" },
      ],
    });
    if (mode === "auto-review")
      expect(f.store.getInteraction(interaction.id)?.review).toMatchObject({
        decision: "escalate",
        target: {
          input: {
            origin: "https://youtube.com",
            action: "open https://youtube.com in the thread browser",
          },
        },
      });
    expect(f.resolve(interaction, "allow_once").ok).toBe(true);
    expect(await first).toMatchObject({ url: expect.stringContaining("youtube.com") });
    expect(f.browser.originsList(f.thread.id)).toMatchObject([
      { origin: "https://youtube.com", scope: "page" },
    ]);
    expect(await f.headless.opens[0]?.allowed("wss://youtube.com/socket")).toBe(true);
    const again = f.opened();
    const second = f.navigation();
    expect(f.resolve(await again, "allow_thread").ok).toBe(true);
    await second;
    await f.navigation();
    expect(f.browser.originsList(f.thread.id)).toMatchObject([{ origin: "https://youtube.com" }]);
    f.browser.originsRevoke(f.thread.id, "https://youtube.com");
    expect(await f.headless.opens[0]?.allowed("wss://youtube.com/socket")).toBe(false);
    const denied = f.opened();
    const failure = expect(f.navigation()).rejects.toMatchObject({
      blocked: { reason: "denied", origin: "https://youtube.com" },
    });
    expect(f.resolve(await denied, "deny").ok).toBe(true);
    await failure;
  },
);
it("unanswered approvals expire, reject late answers and leave no unresolved interaction", async () => {
  const f = await originFixture();
  const origins = new BrowserOrigins({
    store: f.store,
    now: () => 1000,
    id: () => "timeout-approval",
    mode: async () => "ask",
    allowlist: async () => [],
    timeoutMs: 20,
  });
  const headless = new FakeHeadless();
  const browser = new BrowserService({
    dataDir: f.home,
    headlessBackend: headless,
    ffmpeg: "/nonexistent",
    originPolicy: (request) => origins.allowed(request),
    origins,
  });
  try {
    await browser.open({ threadId: f.thread.id, workspaceId: f.thread.workspaceId });
    const opened = f.opened();
    const failure = expect(
      browser.execute(f.thread.id, { action: "navigate", url: "https://timeout.example" }),
    ).rejects.toMatchObject({ blocked: { reason: "timeout", origin: "https://timeout.example" } });
    const interaction = await opened;
    await failure;
    expect(f.store.getInteraction(interaction.id)?.state).toBe("expired");
    expect(f.resolve(interaction, "allow_thread").ok).toBe(false);
    expect(origins.list(f.thread.id)).toEqual([]);
  } finally {
    await browser.close();
    origins.close();
  }
});
it("the global user allowlist permits exact origins and matching WebSockets, with scheme and port isolation", async () => {
  const f = await originFixture();
  await f.settings.set("browser.allowedOrigins", ["https://youtube.com"], { kind: "global" });
  expect(await f.navigation()).toMatchObject({ url: expect.stringContaining("youtube.com") });
  const backend = f.headless.opens[0];
  expect(await backend?.allowed("wss://youtube.com/live")).toBe(true);
  expect(await backend?.allowed("ws://youtube.com/live")).toBe(false);
  expect(await backend?.allowed("wss://youtube.com:8443/live")).toBe(false);
  await f.settings.set("browser.allowedOrigins", [], { kind: "global" });
  expect(await backend?.allowed("wss://youtube.com/live")).toBe(false);
  await expect(
    f.settings.set("browser.allowedOrigins", ["https://youtube.com"], {
      kind: "thread",
      thread: f.thread.id,
    }),
  ).rejects.toThrow("global user setting");
});
it("grant changes require operate while authorized viewers can list effective grants", async () => {
  const f = await originFixture();
  const readonly = f.store.devices.create("Viewer", ["read"], 1000);
  const viewer = await f.client(readonly.token, readonly.device.id);
  const excluded = await f.client("a".repeat(64), "excluded");
  const owner = await f.client();
  for (const connection of [viewer, excluded])
    for (const type of ["browser.origins.list", "browser.origins.grant", "browser.origins.revoke"])
      expect(
        await connection.request({
          type,
          requestId: type,
          threadId: f.thread.id,
          origin: "https://youtube.com",
        }),
      ).toMatchObject({ ok: connection === viewer && type === "browser.origins.list" });
  expect(
    await owner.request({
      type: "browser.origins.grant",
      requestId: "grant",
      threadId: f.thread.id,
      origin: "https://youtube.com",
    }),
  ).toMatchObject({ ok: true });
  await f.navigation();
  expect(
    await owner.request({
      type: "browser.origins.revoke",
      requestId: "revoke",
      threadId: f.thread.id,
      origin: "https://youtube.com",
    }),
  ).toMatchObject({ ok: true, result: [] });
  const opened = f.opened();
  const failure = expect(f.navigation()).rejects.toMatchObject({ blocked: { reason: "denied" } });
  f.resolve(await opened, "deny");
  await failure;
});

it("engine browser approvals keep the tree needing a human and resolve without native provider intents", async () => {
  const { harness, scriptFrames, start } = await import("./engine/test-support.ts");
  const { createLogger } = await import("@ace/diagnostics");
  const { startBrowser } = await import("./services/browser.ts");
  const { Resources } = await import("./services/resources.ts");
  const { Command } = await import("@ace/protocol");
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start)] }], frames);
  const resources = new Resources();
  const log = createLogger({
    now: h.clock.now,
    redact: (line) => line,
    level: "silent",
    sink: { async write() {}, async close() {} },
  });
  let browserId = 0;
  const context: import("./services/types.ts").ServiceContext = {
    config: {
      dataDir: h.home,
      host: "127.0.0.1",
      port: 0,
      remotePort: 0,
      listen: "local",
      logLevel: "silent",
    },
    options: { browser: { headlessBackend: new FakeHeadless(), ffmpeg: "/nonexistent" } },
    store: h.store,
    now: h.clock.now,
    id: () => `browser-host-${++browserId}`,
    log,
    resources,
    signal: new AbortController().signal,
    services: { engine: h.engine, handler: h.engine.handler },
    onListen: [],
  };
  try {
    const threadId = await h.create();
    await startBrowser(context);
    h.engine.bindHostInteractions(
      (command) =>
        context.services.browserApprovals?.resolve(command) ??
        context.services.browserOrigins?.resolve(command),
    );
    // A later host owner, such as Deck, must not replace the browser owner.
    h.engine.bindHostInteractions(() => undefined);
    readyServices(context.services);
    const browser = context.services.browser;
    if (!browser) throw new Error("Browser unavailable");
    await browser.open({ threadId, workspaceId: h.workspace });
    const opened = new Promise<import("@ace/protocol").Interaction>((resolve) => {
      const stop = h.store.subscribe((events) => {
        for (const event of events)
          if (event.payload.type === "interaction.opened") {
            stop();
            resolve(event.payload.interaction);
          }
      });
    });
    const navigation = browser.execute(threadId, {
      action: "navigate",
      url: "https://youtube.com",
    });
    const interaction = await opened;
    expect(h.store.getThread(threadId)?.status).toMatchObject({
      state: "needs_you",
      interactions: 1,
    });
    expect(h.store.getInteraction(interaction.id)?.review?.decision).toBe("escalate");
    const command = Command.parse({
      id: "allow-browser",
      deviceId: "owner",
      payload: {
        type: "interaction.resolve",
        interactionId: interaction.id,
        resolution: { kind: "approval", optionId: "allow_thread" },
      },
    });
    expect(h.engine.handler.handle(command, h.store)).toMatchObject({ ok: true });
    await navigation;
    await h.engine.flush();
    expect(h.store.getThread(threadId)?.status.state).toBe("working");
    expect(h.adapter.commands.some((entry) => entry.type === "resolve")).toBe(false);
    expect(browser.originsList(threadId)).toMatchObject([{ origin: "https://youtube.com" }]);
    const evaluating = browser.execute(threadId, { action: "evaluate", expression: "1" });
    await h.engine.flush();
    await expect.poll(() => h.store.getThread(threadId)?.status.state).toBe("needs_you");
    const state = h.store.acquireThread(threadId);
    const approval = Object.values(state.interactions).find(
      (entry) =>
        entry.state === "pending" &&
        entry.request.kind === "approval" &&
        entry.request.target?.tool === "browser.evaluate",
    );
    if (!approval) throw new Error("Evaluate approval unavailable");
    expect(h.store.getThread(threadId)?.status.state).toBe("needs_you");
    expect(
      h.engine.handler.handle(
        Command.parse({
          id: "allow-evaluate",
          deviceId: "owner",
          payload: {
            type: "interaction.resolve",
            interactionId: approval.id,
            resolution: { kind: "approval", optionId: "allow_once" },
          },
        }),
        h.store,
      ),
    ).toMatchObject({ ok: true });
    expect(await evaluating).toBe(1);
    browser.takeover(threadId, "private-owner", "private");
    browser.disconnect("private-owner");
    expect(h.store.getThread(threadId)?.status.state).toBe("needs_you");
    const privateGate = Object.values(h.store.snapshotThread(threadId).interactions).find(
      (entry) =>
        entry.state === "pending" && entry.raw.some((raw) => raw.type === "ace.browser.private"),
    );
    if (!privateGate) throw new Error("Private gate missing");
    expect(
      h.engine.handler.handle(
        Command.parse({
          id: "cannot-dismiss-private",
          deviceId: "owner",
          payload: {
            type: "interaction.resolve",
            interactionId: privateGate.id,
            resolution: { kind: "plan_review", decision: "approve" },
          },
        }),
        h.store,
      ),
    ).toMatchObject({ ok: false, error: "private_handback_required" });
    expect(h.store.getThread(threadId)?.status.state).toBe("needs_you");
    await expect(browser.execute(threadId, { action: "snapshot" })).rejects.toMatchObject({
      code: "human_private",
    });
    browser.takeover(threadId, "returning-owner", "private");
    browser.handback(threadId, "returning-owner");
    await h.engine.flush();
    expect(h.store.getThread(threadId)?.status.state).toBe("working");
    await browser.closeThread(threadId);
    h.engine.openHostApproval(threadId, "interrupted-private", privateGate.request, [
      { type: "ace.browser.private", data: { key: "interrupted-private" } },
    ]);
    const reopened = await browser.open({ threadId, workspaceId: h.workspace });
    expect(reopened).toMatchObject({
      controller: "none",
      takeoverMode: "private",
      status: "paused",
    });
    await expect(browser.execute(threadId, { action: "logs" })).rejects.toMatchObject({
      code: "human_private",
    });
    browser.takeover(threadId, "after-interruption", "private");
    browser.handback(threadId, "after-interruption");
    await h.engine.flush();
    expect(h.store.getThread(threadId)?.status.state).toBe("working");
    h.store.releaseThread(threadId);
    expect(h.adapter.commands.some((entry) => entry.type === "resolve")).toBe(false);
    expect(h.errors).toEqual([]);
  } finally {
    await resources.close();
    await log.close();
    await h.close();
  }
});

it("thread grants survive a full public daemon stop and restart with isolated homes and a fake backend", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { startDaemon } = await import("./index.ts");
  const { createDevThread, stubHandler } = await import("./commands.ts");
  const { BrowserClient } = await import("./browser-test-client.ts");
  const home = await mkdtemp(join(tmpdir(), "ace-origin-daemon-restart-"));
  const config: import("./config.ts").Config = {
    dataDir: home,
    host: "127.0.0.1",
    port: 0,
    remotePort: 0,
    listen: "local",
    logLevel: "silent",
  };
  const boot = () =>
    startDaemon({
      config,
      handler: stubHandler(),
      browser: { headlessBackend: new FakeHeadless(), ffmpeg: "/nonexistent" },
      history: { instances: [] },
      modelInstances: [],
    });
  let daemon = await boot();
  let client = new BrowserClient(daemon.url);
  try {
    const workspace = daemon.store.createWorkspace(home, "Browser");
    const thread = createDevThread(daemon.store, workspace);
    await client.hello(await readFile(daemon.tokenPath, "utf8"));
    expect(
      await client.request({
        type: "browser.open",
        requestId: "open",
        options: { threadId: thread.id, workspaceId: workspace },
      }),
    ).toMatchObject({ ok: true });
    await client.request({ type: "browser.takeover", requestId: "take", threadId: thread.id });
    expect(
      await client.request({
        type: "browser.execute",
        requestId: "visit",
        threadId: thread.id,
        command: { action: "navigate", url: "https://youtube.com" },
      }),
    ).toMatchObject({ ok: true });
    await client.close();
    await daemon.close();
    daemon = await boot();
    client = new BrowserClient(daemon.url);
    await client.hello(await readFile(daemon.tokenPath, "utf8"));
    expect(
      await client.request({
        type: "browser.origins.list",
        requestId: "grants",
        threadId: thread.id,
      }),
    ).toMatchObject({ ok: true, result: [{ origin: "https://youtube.com" }] });
    await daemon.browser?.open({ threadId: thread.id, workspaceId: workspace });
    expect(
      await daemon.browser?.execute(thread.id, { action: "navigate", url: "https://youtube.com" }),
    ).toMatchObject({ url: "https://youtube.com" });
  } finally {
    await client.close();
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  }
});
