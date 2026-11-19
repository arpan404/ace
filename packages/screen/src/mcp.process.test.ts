import { expect, it, onTestFinished } from "vitest";
import { CredentialRegistry, ToolRegistry } from "@ace/mcp-server";
import { McpScope } from "@ace/protocol";
import { screenToolkit } from "./index.ts";
import { manager, ready, target } from "./testing/support.ts";
import { helperFixture } from "./testing/support.ts";

it("screen reads expose read-only approval actions and native actions remain effects", async () => {
  const h = await manager({ FAKE_V2: "1" });
  onTestFinished(h.close);
  await ready(h.screen);
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  screenToolkit(h.screen).register(registry);
  const credentials = new CredentialRegistry(() => "a".repeat(64));
  onTestFinished(() => credentials.close());
  const lease = credentials.issue(
    McpScope.parse({
      sessionId: "screen",
      threadId: "thread",
      agentId: "root",
      capabilities: ["screen"],
    }),
    new AbortController().signal,
  );
  expect(registry.action("screen_ui_tree", {})).toMatchObject({
    origin: "ace",
    riskClass: "read-only",
    access: "read",
  });
  expect(registry.action("screen_ui_act", { ref: "button", action: "press" })).toMatchObject({
    origin: "ace",
    riskClass: "external-effect",
    access: "write",
    description: expect.stringContaining("button"),
  });
  expect(
    registry.list(lease.principal).find((tool) => tool.name === "screen_ui_tree"),
  ).toMatchObject({ annotations: { readOnlyHint: true, destructiveHint: false } });
  expect(
    registry.list(lease.principal).find((tool) => tool.name === "screen_ui_act"),
  ).toMatchObject({ annotations: { readOnlyHint: false } });
});

it("an agent opens, types into and foregrounds any app, a web browser included, with no prompt", async () => {
  const h = await manager(
    {},
    { args: [new URL("./testing/fake-helper-behavior.ts", import.meta.url).pathname] },
  );
  onTestFinished(h.close);
  await h.screen.enable(true);
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  screenToolkit(h.screen).register(registry);
  const credentials = new CredentialRegistry(() => "a".repeat(64));
  onTestFinished(() => credentials.close());
  const lease = credentials.issue(
    McpScope.parse({
      sessionId: "mcp",
      threadId: "thread",
      agentId: "root",
      capabilities: ["screen"],
    }),
    new AbortController().signal,
  );
  const call = (name: string, args: Record<string, unknown>) =>
    registry.call(name, args, lease.principal, new AbortController().signal);
  for (const [name, args] of [
    ["screen_open_app", { bundleId: "com.apple.Safari" }],
    ["screen_input", { action: "type", text: "release notes" }],
    ["screen_open_app", { bundleId: "com.apple.Safari", mode: "foreground" }],
  ] as const) {
    const result = await call(name, args);
    expect(result.isError, `${name}: ${JSON.stringify(result.content)}`).not.toBe(true);
  }
  expect(h.screen.states()).toMatchObject([
    {
      target: { bundleId: "com.apple.Safari" },
      controller: "agent",
      holder: { threadId: "thread", agentId: "root" },
      mode: "foreground",
    },
  ]);
});

it("reopening an app with another window returns the replacement session and keeps it usable", async () => {
  const h = await manager(
    { LEGACY_HELPER: "1" },
    { args: [new URL("./testing/fake-helper-behavior.ts", import.meta.url).pathname] },
  );
  onTestFinished(h.close);
  await h.screen.enable(true);
  const caller = { threadId: "thread", agentId: "root" };
  const state = await h.screen.openAgentApp(
    target.bundleId,
    caller,
    new AbortController().signal,
    1,
  );
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  screenToolkit(h.screen).register(registry);
  const credentials = new CredentialRegistry(() => "a".repeat(64));
  onTestFinished(() => credentials.close());
  const lease = credentials.issue(
    McpScope.parse({ sessionId: "mcp", ...caller, capabilities: ["screen"] }),
    new AbortController().signal,
  );
  const result = await registry.call(
    "screen_open_app",
    { bundleId: target.bundleId, windowId: 2 },
    lease.principal,
    new AbortController().signal,
  );
  expect(result.isError).not.toBe(true);
  expect(result["_meta"]).toMatchObject({
    "ace/screen": { sessionId: h.screen.agentSession(caller) },
  });
  expect(h.screen.agentSession(caller)).not.toBe(state.sessionId);
  const typed = await registry.call(
    "screen_input",
    { action: "type", sessionId: h.screen.agentSession(caller), text: "replacement works" },
    lease.principal,
    new AbortController().signal,
  );
  expect(typed.isError).not.toBe(true);
});

const windowsBundle = "c:\\program files\\ace fixture\\editor.exe";
const windowsCaller = { threadId: "thread", agentId: "root" };

async function windowsApp(env: NodeJS.ProcessEnv = {}) {
  const fixture = await helperFixture("win32", {
    env: { ...env, TARGET_BUNDLE: windowsBundle, PAYLOAD_VALUE: "1" },
  });
  onTestFinished(() => fixture.close());
  const screen = fixture.manager;
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  screenToolkit(screen).register(registry);
  const credentials = new CredentialRegistry(() => "a".repeat(64));
  onTestFinished(() => credentials.close());
  const lease = credentials.issue(
    McpScope.parse({ sessionId: "mcp", ...windowsCaller, capabilities: ["screen"] }),
    new AbortController().signal,
  );
  const call = (name: string, args: Record<string, unknown>) =>
    registry.call(name, args, lease.principal, new AbortController().signal);
  return { screen, call };
}

it.runIf(process.platform === "win32")(
  "an agent rejoins a running Windows window and can edit its UI in foreground mode",
  async () => {
    const { screen, call } = await windowsApp();
    const opened = await call("screen_open_app", { bundleId: windowsBundle, windowId: 1 });
    expect(opened.isError).not.toBe(true);
    expect(opened["_meta"]).toMatchObject({ "ace/screen": { mode: "foreground" } });
    expect(screen.states()).toMatchObject([
      {
        target: { kind: "window", bundleId: windowsBundle, windowId: 1 },
        mode: "foreground",
        holder: windowsCaller,
      },
    ]);
    const edited = await call("screen_ui_act", { ref: "save", action: "setValue", value: "雪 ✓" });
    expect(edited.isError).not.toBe(true);
    const tree = await call("screen_ui_tree", {});
    expect(tree.content).toMatchObject([{ text: expect.stringContaining("雪 ✓") }]);
    await expect(
      screen.openAgentApp(
        windowsBundle,
        { ...windowsCaller, agentId: "other" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "target_busy" });
  },
);

it.runIf(process.platform === "win32")(
  "Windows background and URL requests are refused before acquiring a session",
  async () => {
    const { screen, call } = await windowsApp();
    const background = await call("screen_open_app", {
      bundleId: windowsBundle,
      mode: "background",
    });
    expect(background.isError).toBe(true);
    expect(background.content).toMatchObject([
      { text: expect.stringContaining("foreground_required") },
    ]);
    expect(screen.states()).toEqual([]);
    const url = await call("screen_open_app", {
      bundleId: windowsBundle,
      url: "https://example.test/",
    });
    expect(url.isError).toBe(true);
    expect(url.content).toMatchObject([{ text: expect.stringContaining("not_supported") }]);
    expect(screen.states()).toEqual([]);
  },
);

it.runIf(process.platform === "win32")(
  "Windows executable identity and selected window must match the running inventory",
  async () => {
    const { screen } = await windowsApp();
    const signal = new AbortController().signal;
    await expect(
      screen.openAgentApp(windowsBundle.toUpperCase(), windowsCaller, signal),
    ).rejects.toMatchObject({
      code: "target_gone",
    });
    await expect(
      screen.openAgentApp(windowsBundle, windowsCaller, signal, 99),
    ).rejects.toMatchObject({
      code: "target_gone",
    });
    expect(screen.states()).toEqual([]);
    await screen.enable(false);
    await expect(
      screen.openAgentApp(windowsBundle, windowsCaller, signal, 1),
    ).rejects.toMatchObject({
      code: "screen_disabled",
    });
  },
);

it.runIf(process.platform === "win32")(
  "multiple Windows windows require an explicit choice before capture starts",
  async () => {
    const { screen, call } = await windowsApp({ MULTIPLE_WINDOWS: "1" });
    await expect(
      screen.openAgentApp(windowsBundle, windowsCaller, new AbortController().signal),
    ).rejects.toMatchObject({ code: "window_ambiguous" });
    expect(screen.states()).toEqual([]);
    const selected = await call("screen_open_app", { bundleId: windowsBundle, windowId: 2 });
    expect(selected.isError).not.toBe(true);
    expect(screen.states()).toMatchObject([
      { target: { kind: "window", bundleId: windowsBundle, windowId: 2 }, mode: "foreground" },
    ]);
  },
);
