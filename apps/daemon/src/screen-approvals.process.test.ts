import { expect, test, onTestFinished } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "@ace/protocol";
import { Store } from "./store.ts";
import { createDevThread } from "./commands.ts";
import { ScreenGrants } from "./screen-grants.ts";
import { ScreenApprovals } from "./screen-approvals.ts";
import { harness, scriptFrames, start } from "./engine/test-support.ts";

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "ace-screen-grants-"));
  const path = join(home, "events.sqlite"),
    store = new Store(path);
  const workspace = store.createWorkspace(home, "Screen", 1000),
    thread = createDevThread(store, workspace);
  let turn = "turn1",
    serial = 0;
  const grants = new ScreenGrants(
    store,
    () => 1000,
    () => turn,
  );
  const deadlines = new Map<() => void, number>();
  const approvals = new ScreenApprovals({
    store,
    grants,
    now: () => 1000,
    id: () => `screen-${++serial}`,
    engine: () => undefined,
    schedule: (callback, milliseconds) => {
      deadlines.set(callback, milliseconds);
      return () => {
        deadlines.delete(callback);
      };
    },
  });
  const caller = { threadId: thread.id, agentId: "agent" };
  onTestFinished(async () => {
    approvals.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  });
  const resolve = (optionId: string) => {
    const pending = Object.values(store.snapshotThread(thread.id).interactions).find(
      (value) => value.state === "pending",
    );
    if (!pending) throw new Error("Missing approval");
    return approvals.resolve(
      Command.parse({
        id: `command-${++serial}`,
        deviceId: "human",
        payload: {
          type: "interaction.resolve",
          interactionId: pending.id,
          resolution: { kind: "approval", optionId },
        },
      }),
    );
  };
  return {
    home,
    path,
    store,
    thread,
    grants,
    approvals,
    caller,
    resolve,
    expire: () => {
      for (const [callback, milliseconds] of deadlines) if (milliseconds <= 60_000) callback();
    },
    nextTurn: () => {
      turn = "turn2";
    },
  };
}

test("turn grants expire, thread and always grants survive restart, and disablement persists", async () => {
  const h = await fixture();
  h.grants.enable(true);
  h.grants.approve("dev.test.turn", true, "turn", h.thread.id);
  h.grants.approve("dev.test.thread", true, "thread", h.thread.id);
  h.grants.approve("dev.test.always", true, "always");
  expect(h.grants.allowlist(h.caller)).toContain("dev.test.turn");
  h.nextTurn();
  expect(h.grants.allowlist(h.caller)).not.toContain("dev.test.turn");
  const reopened = new Store(h.path);
  onTestFinished(() => reopened.close());
  const restarted = new ScreenGrants(
    reopened,
    () => 2000,
    () => "turn2",
  );
  expect(restarted.enabled()).toBe(true);
  expect(restarted.allowlist(h.caller)).toEqual(
    expect.arrayContaining(["dev.test.thread", "dev.test.always"]),
  );
  expect(restarted.allowlist()).toEqual(["dev.test.always"]);
  restarted.enable(false);
  expect(
    new ScreenGrants(
      h.store,
      () => 3000,
      () => "turn2",
    ).enabled(),
  ).toBe(false);
  restarted.approve("dev.test.thread", true, "always");
  expect(restarted.list()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ bundleId: "dev.test.thread", scope: "thread" }),
    ]),
  );
  restarted.approve("dev.test.thread", false, "always");
  expect(restarted.allowlist(h.caller)).toContain("dev.test.thread");
  restarted.approve("dev.test.thread", false, "thread", h.thread.id);
  expect(restarted.allowlist(h.caller)).not.toContain("dev.test.thread");
});

test("agent app requests persist the human's chosen scope and sensitive apps always ask again", async () => {
  const h = await fixture();
  h.grants.enable(true);
  const signal = new AbortController().signal;
  const requested = h.approvals.request(
    "dev.example.app",
    "Edit a disposable fixture",
    h.caller,
    signal,
  );
  expect(h.resolve("allow_thread")?.ok).toBe(true);
  await requested;
  expect(h.grants.allowlist(h.caller)).toContain("dev.example.app");
  const terminal = h.approvals.request(
    "com.apple.Terminal",
    "Inspect a temporary terminal",
    h.caller,
    signal,
  );
  expect(h.resolve("allow_always")?.ok).toBe(true);
  await terminal;
  const again = h.approvals.request("com.apple.Terminal", "Use terminal again", h.caller, signal);
  const denied = expect(again).rejects.toThrow("denied");
  expect(h.resolve("deny")?.ok).toBe(true);
  await denied;
  expect(h.grants.allows("com.apple.Terminal", h.caller)).toBe(false);
  h.nextTurn();
  expect(h.grants.allowlist(h.caller)).not.toContain("com.apple.Terminal");
});

test("cancelled approval opens no grant and pending host approvals expire on recovery", async () => {
  const h = await fixture();
  h.grants.enable(true);
  const abort = new AbortController();
  const requested = h.approvals.request(
    "dev.example.cancel",
    "Cancelled work",
    h.caller,
    abort.signal,
  );
  const rejected = expect(requested).rejects.toThrow();
  abort.abort();
  await rejected;
  expect(h.grants.allowlist(h.caller)).toEqual([]);
  const recovery = h.approvals.request(
    "dev.example.recovery",
    "Interrupted work",
    h.caller,
    new AbortController().signal,
  );
  const expired = expect(recovery).rejects.toThrow("expired");
  h.approvals.recover();
  await expired;
  expect(
    Object.values(h.store.snapshotThread(h.thread.id).interactions).every(
      (value) => value.state === "expired",
    ),
  ).toBe(true);
});

test("foreground approval blocks the engine tree until a human resolves it", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start)] }], frames, {
    permissionSettings: async () => "auto-review",
  });
  onTestFinished(h.close);
  const threadId = await h.create();
  let serial = 0;
  const grants = new ScreenGrants(h.store, h.clock.now, () => h.engine.screenTurn(threadId));
  grants.enable(true);
  const approvals = new ScreenApprovals({
    store: h.store,
    grants,
    now: h.clock.now,
    id: () => `screen-${++serial}`,
    engine: () => h.engine,
    schedule: () => () => {},
  });
  onTestFinished(() => approvals.close());
  h.engine.bindHostInteractions((command) => approvals.resolve(command));
  const agentId = h.engine.rootAgent(threadId);
  if (!agentId) throw new Error("Missing root");
  const requested = approvals.foreground(
    {
      sessionId: "session",
      lifecycle: "live",
      controller: "agent",
      indicator: false,
      target: { kind: "window", bundleId: "dev.example.app", windowId: 1 },
      permissions: { screenRecording: true, accessibility: true },
      mode: "background",
      secureInputAllowed: false,
      holder: { threadId, agentId },
    },
    new AbortController().signal,
  );
  void requested.catch(() => {});
  const pending = Object.values(h.store.snapshotThread(threadId).interactions).find(
    (value) => value.state === "pending",
  );
  expect(h.store.getThread(threadId)?.status.state).toBe("needs_you");
  if (!pending) throw new Error("Missing foreground approval");
  expect(pending.review).toBeUndefined();
  const command = Command.parse({
    id: "allow-foreground",
    deviceId: "human",
    payload: {
      type: "interaction.resolve",
      interactionId: pending.id,
      resolution: { kind: "approval", optionId: "allow_once" },
    },
  });
  expect(h.command(command.payload, command.deviceId, command.id).ok).toBe(true);
  await requested;
  expect(h.store.getInteraction(pending.id)?.state).toBe("resolved");
});

test("secure-field audit steps omit text and a takeover cancels pending foreground escalation", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start)] }], frames);
  onTestFinished(h.close);
  const threadId = await h.create(),
    agentId = h.engine.rootAgent(threadId);
  if (!agentId) throw new Error("Missing root");
  const [{ ScreenManager }, { startScreen }, { Resources }, { createLogger }] = await Promise.all([
    import("@ace/screen"),
    import("./services/screen.ts"),
    import("./services/resources.ts"),
    import("@ace/diagnostics"),
  ]);
  let serial = 0;
  const resources = new Resources();
  onTestFinished(() => resources.close());
  const log = createLogger({
    now: h.clock.now,
    redact: (line) => line,
    level: "silent",
    sink: { async write() {}, async close() {} },
  });
  resources.own(() => log.close());
  const screen = new ScreenManager({
    command: process.execPath,
    args: [
      new URL("../../../packages/screen/src/testing/fake-helper.ts", import.meta.url).pathname,
    ],
    env: { FAKE_V2: "1", SECURE_TEXT: "1" },
    nextId: () => `audit-${++serial}`,
    recordingDirectory: join(h.home, "screen-artifacts"),
    publishArtifact: async () => {},
  });
  const context: import("./services/types.ts").ServiceContext = {
    config: {
      dataDir: h.home,
      host: "127.0.0.1",
      port: 0,
      remotePort: 0,
      listen: "local",
      logLevel: "silent",
    },
    options: { screen },
    store: h.store,
    now: h.clock.now,
    id: () => `screen-event-${++serial}`,
    log,
    resources,
    services: { engine: h.engine },
    onListen: [],
    signal: new AbortController().signal,
  };
  await startScreen(context);
  const { startMcp } = await import("./services/mcp.ts");
  const { invoke } = await import("./browser-mcp-test-support.ts");
  await startMcp(context);
  h.engine.bindHostInteractions((command) => context.services.screenApprovals?.resolve(command));
  await screen.enable(true);
  await screen.approve("dev.example.audit", true);
  const state = await screen.start({ kind: "window", bundleId: "dev.example.audit", windowId: 1 });
  screen.delegateAgent(state.sessionId, { threadId, agentId });
  const mcp = context.services.mcp;
  if (!mcp) throw new Error("Missing audit MCP service");
  const lease = mcp.openSession(
    { sessionId: "audit-mcp", threadId, agentId, capabilities: ["screen"] },
    new AbortController().signal,
  );
  const connection = { url: mcp.url, bearer: lease.bearer };
  const denied = await (await invoke(connection, "screen_type", { text: "dont-leak-me" })).json();
  expect(denied).toMatchObject({
    result: {
      isError: true,
      content: [{ text: expect.stringContaining("secure_input_required") }],
    },
  });
  screen.secureInput(state.sessionId, true);
  const accepted = await (await invoke(connection, "screen_type", { text: "dont-leak-me" })).json();
  expect(accepted.result.isError).not.toBe(true);
  expect(accepted).toMatchObject({ result: { content: expect.any(Array) } });
  const steps = Object.values(h.store.snapshotThread(threadId).items).filter(
    (item) => item.type === "notice" && item.code === "screen.step",
  );
  expect(steps).toHaveLength(2);
  expect(JSON.stringify(steps)).not.toContain("dont-leak-me");
  expect(JSON.stringify(steps)).toContain("secure_input_required");
  const escalation = screen.mode(state.sessionId, "foreground");
  const cancelled = expect(escalation).rejects.toThrow("Controller changed");
  const interaction = Object.values(h.store.snapshotThread(threadId).interactions).find(
    (value) => value.state === "pending",
  );
  if (!interaction) throw new Error("Missing foreground gate");
  expect(screen.state(state.sessionId).mode).toBe("background");
  screen.controller(state.sessionId, "human", "human");
  await cancelled;
  expect(h.store.getInteraction(interaction.id)?.state).toBe("expired");
  expect(
    h.command({
      type: "interaction.resolve",
      interactionId: interaction.id,
      resolution: { kind: "approval", optionId: "allow_once" },
    }).ok,
  ).toBe(false);
  expect(screen.state(state.sessionId)).toMatchObject({
    controller: "human",
    mode: "background",
    secureInputAllowed: false,
  });
  await screen.stopAll();
  const persisted = new ScreenGrants(h.store, h.clock.now, () => undefined);
  expect(persisted.enabled()).toBe(false);
  await screen.enable(true);
  await screen.close();
  expect(persisted.enabled()).toBe(true);
});

test("a thread grant cannot authorize another thread in the same workspace", async () => {
  const h = await fixture();
  h.grants.enable(true);
  h.grants.approve("dev.test.app", true, "thread", h.thread.id);
  const other = createDevThread(h.store, h.thread.workspaceId);
  expect(h.grants.allows("dev.test.app", h.caller)).toBe(true);
  expect(h.grants.allows("dev.test.app", { ...h.caller, threadId: other.id })).toBe(false);
  const approval = h.approvals.request(
    "dev.test.app",
    "Other thread",
    { ...h.caller, threadId: other.id },
    new AbortController().signal,
  );
  const expired = expect(approval).rejects.toMatchObject({ code: "timeout" });
  expect(
    Object.values(h.store.snapshotThread(other.id).interactions).some(
      (item) => item.state === "pending",
    ),
  ).toBe(true);
  h.expire();
  await expired;
  expect(
    Object.values(h.store.snapshotThread(other.id).interactions).every(
      (item) => item.state === "expired",
    ),
  ).toBe(true);
});

test("host approval deadlines expire and prevent late approval from granting access", async () => {
  const h = await fixture();
  h.grants.enable(true);
  const pending = expect(
    h.approvals.request("dev.test.app", "Deadline", h.caller, new AbortController().signal),
  ).rejects.toMatchObject({ code: "timeout" });
  const interaction = Object.values(h.store.snapshotThread(h.thread.id).interactions).find(
    (item) => item.state === "pending",
  );
  if (!interaction) throw new Error("Missing interaction");
  h.expire();
  await pending;
  expect(h.store.getInteraction(interaction.id)?.state).toBe("expired");
  expect(
    h.approvals.resolve(
      Command.parse({
        id: "late",
        deviceId: "human",
        payload: {
          type: "interaction.resolve",
          interactionId: interaction.id,
          resolution: { kind: "approval", optionId: "allow_always" },
        },
      }),
    ),
  ).toBeUndefined();
  expect(h.grants.allows("dev.test.app", h.caller)).toBe(false);
});

test.each([
  "com.apple.Safari",
  "com.google.Chrome",
  "company.thebrowser.Browser",
  "org.mozilla.firefox",
  "com.brave.Browser.beta",
])("%s computer use requires a human UI grant and never accepts Always", async (bundleId) => {
  const h = await fixture();
  h.grants.enable(true);
  await expect(
    h.approvals.request(bundleId, "Visit a website", h.caller, new AbortController().signal),
  ).rejects.toMatchObject({ code: "approval_required" });
  expect(
    Object.values(h.store.snapshotThread(h.thread.id).interactions).filter(
      (entry) => entry.state === "pending",
    ),
  ).toEqual([]);
  expect(() => h.grants.approve(bundleId, true, "always")).toThrow("turn or thread grant");
  h.grants.approve(bundleId, true, "thread", h.thread.id);
  await h.approvals.request(
    bundleId,
    "Human granted browser settings",
    h.caller,
    new AbortController().signal,
  );
  expect(h.grants.allows(bundleId, h.caller)).toBe(true);
  h.grants.approve(bundleId, false, "thread", h.thread.id);
  await expect(
    h.approvals.request(bundleId, "Visit a website", h.caller, new AbortController().signal),
  ).rejects.toMatchObject({ code: "approval_required" });
});
