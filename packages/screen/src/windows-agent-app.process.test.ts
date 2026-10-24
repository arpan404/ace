import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vitest";
import { CredentialRegistry, ToolRegistry } from "@ace/mcp-server";
import { McpScope } from "@ace/protocol";
import { ScreenManager, screenToolkit } from "./index.ts";
import { ids } from "./testing/support.ts";

const bundleId = "c:\\program files\\ace fixture\\editor.exe";
const caller = { threadId: "thread", agentId: "root" };

async function fixture(env: NodeJS.ProcessEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), "screen-windows-app-"));
  const manager = new ScreenManager({
    command: process.execPath,
    args: [fileURLToPath(new URL("./testing/fake-helper-v2.ts", import.meta.url))],
    platform: "win32",
    endpoint: `unix:${join(directory, "frames")}`,
    env: { ...env, TARGET_BUNDLE: bundleId, PAYLOAD_VALUE: "1" },
    nextId: ids(),
    recordingDirectory: directory,
    publishArtifact: async () => {},
  });
  onTestFinished(async () => {
    try {
      await manager.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  await manager.enable(true);
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  screenToolkit(manager).register(registry);
  const credentials = new CredentialRegistry(() => "a".repeat(64));
  onTestFinished(() => credentials.close());
  const lease = credentials.issue(
    McpScope.parse({ sessionId: "mcp", ...caller, capabilities: ["screen"] }),
    new AbortController().signal,
  );
  const call = (name: string, args: Record<string, unknown>) =>
    registry.call(name, args, lease.principal, new AbortController().signal);
  return { manager, call };
}

it("an agent rejoins a running Windows window and can edit its UI in foreground mode", async () => {
  const { manager, call } = await fixture();
  const opened = await call("screen_open_app", { bundleId, windowId: 1 });
  expect(opened.isError).not.toBe(true);
  expect(opened["_meta"]).toMatchObject({ "ace/screen": { mode: "foreground" } });
  expect(manager.states()).toMatchObject([
    { target: { kind: "window", bundleId, windowId: 1 }, mode: "foreground", holder: caller },
  ]);
  const edited = await call("screen_ui_act", { ref: "save", action: "setValue", value: "雪 ✓" });
  expect(edited.isError).not.toBe(true);
  const tree = await call("screen_ui_tree", {});
  expect(tree.content).toMatchObject([{ text: expect.stringContaining("雪 ✓") }]);
  await expect(
    manager.openAgentApp(bundleId, { ...caller, agentId: "other" }, new AbortController().signal),
  ).rejects.toMatchObject({ code: "target_busy" });
});

it("Windows background and URL requests are refused before acquiring a session", async () => {
  const { manager, call } = await fixture();
  const background = await call("screen_open_app", { bundleId, mode: "background" });
  expect(background.isError).toBe(true);
  expect(background.content).toMatchObject([
    { text: expect.stringContaining("foreground_required") },
  ]);
  expect(manager.states()).toEqual([]);
  const url = await call("screen_open_app", { bundleId, url: "https://example.test/" });
  expect(url.isError).toBe(true);
  expect(url.content).toMatchObject([{ text: expect.stringContaining("not_supported") }]);
  expect(manager.states()).toEqual([]);
});

it("Windows executable identity and selected window must match the running inventory", async () => {
  const { manager } = await fixture();
  const signal = new AbortController().signal;
  await expect(manager.openAgentApp(bundleId.toUpperCase(), caller, signal)).rejects.toMatchObject({
    code: "target_gone",
  });
  await expect(manager.openAgentApp(bundleId, caller, signal, 99)).rejects.toMatchObject({
    code: "target_gone",
  });
  expect(manager.states()).toEqual([]);
  await manager.enable(false);
  await expect(manager.openAgentApp(bundleId, caller, signal, 1)).rejects.toMatchObject({
    code: "screen_disabled",
  });
});

it("multiple Windows windows require an explicit choice before capture starts", async () => {
  const { manager, call } = await fixture({ MULTIPLE_WINDOWS: "1" });
  await expect(
    manager.openAgentApp(bundleId, caller, new AbortController().signal),
  ).rejects.toMatchObject({ code: "window_ambiguous" });
  expect(manager.states()).toEqual([]);
  const selected = await call("screen_open_app", { bundleId, windowId: 2 });
  expect(selected.isError).not.toBe(true);
  expect(manager.states()).toMatchObject([
    { target: { kind: "window", bundleId, windowId: 2 }, mode: "foreground" },
  ]);
});
