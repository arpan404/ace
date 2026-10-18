import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { CredentialRegistry, ToolRegistry } from "@ace/mcp-server";
import { McpScope } from "@ace/protocol";
import { ComputerClient } from "./client.ts";
import { computerToolkit } from "./toolkit.ts";

const fake = fileURLToPath(new URL("./testing/fake-computer-helper.ts", import.meta.url));
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function world(env: Record<string, string> = {}, actDeadlineMs?: number) {
  const dir = await mkdtemp(join(tmpdir(), "ace-computer-"));
  const logPath = join(dir, "ops.log");
  let starts = 0;
  let next = 0;
  const client = new ComputerClient({
    helper: async () => "fake-helper",
    nextId: () => `r${++next}`,
    ...(actDeadlineMs
      ? { deadlineMs: (op: string) => (op === "act" ? actDeadlineMs : 20_000) }
      : {}),
    spawnHelper: (_command, args) => {
      starts++;
      return spawn(process.execPath, [fake, ...args], {
        env: { ...process.env, FAKE_LOG: logPath, ...env },
        stdio: ["pipe", "pipe", "pipe"],
      });
    },
  });
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  computerToolkit(client).register(registry);
  const credentials = new CredentialRegistry(() => "a".repeat(64));
  const lease = credentials.issue(
    McpScope.parse({
      sessionId: "s",
      threadId: "thread",
      agentId: "root",
      capabilities: ["screen"],
    }),
    new AbortController().signal,
  );
  cleanups.push(
    () => client.close(),
    () => credentials.close(),
    () => rm(dir, { recursive: true, force: true }),
  );
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await registry.call(name, args, lease.principal, new AbortController().signal);
    const text = result.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n");
    return { result, text };
  };
  const ops = async () =>
    (await readFile(logPath, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  return { call, ops, starts: () => starts, dir };
}

it("an agent reads the outline once, then only the change its actions caused", async () => {
  const { call } = await world();
  const first = await call("screen_state", { app: "Calculator" });
  expect(first.text).toContain("1 standard window Calculator\n\t6 text 0\n\t23 button 7");
  expect(first.text).toContain("Menu bar: Calculator, Edit");

  const acted = await call("screen_act", {
    app: "Calculator",
    actions: [{ type: "type", text: "12*34=" }],
  });
  expect(acted.result.isError).toBeFalsy();
  expect(acted.text).toContain("1. typed 6 characters");
  expect(acted.text).toContain("~\t6 text 408");
  expect(acted.text).not.toContain("23 button 7");

  expect((await call("screen_state", { app: "Calculator" })).text).toContain(
    "No change since your last look.",
  );
});

it("a terminal is refused before the helper opens or touches it", async () => {
  const { call, ops } = await world();
  const refused = await call("screen_act", {
    app: "Terminal",
    actions: [{ type: "type", text: "rm -rf ~" }],
  });
  expect(refused.result.isError).toBe(true);
  expect(refused.text).toContain("does not operate this app");
  expect(await ops()).toEqual(["resolve Terminal"]);
});

it("the helper's own explanation of a failed step reaches the model, with what already ran", async () => {
  const { call } = await world();
  await call("screen_state", { app: "Calculator" });
  const partial = await call("screen_act", {
    app: "Calculator",
    actions: [
      { type: "key", key: "Escape" },
      { type: "menu", path: ["Fiel", "New"] },
      { type: "type", text: "x" },
    ],
  });
  expect(partial.text).toContain("1. did key");
  expect(partial.text).toContain(
    'Action 2 (menu) failed: No "Fiel" in the menu bar. Items: Calculator, Edit. The actions after it did not run.',
  );
});

it("an unknown app gets the helper's suggestion, not a generic failure", async () => {
  const { call } = await world();
  const missing = await call("screen_state", { app: "Photoshop" });
  expect(missing.result.isError).toBe(true);
  expect(missing.text).toBe('No installed app matches "Photoshop".');
});

it("a helper that crashes costs one call; the next call starts a fresh helper", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ace-computer-crash-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const { call, starts } = await world({ FAKE_CRASH_ONCE: join(dir, "crashed") });
  const crashed = await call("screen_state", { app: "Calculator" });
  expect(crashed.result.isError).toBe(true);
  expect(crashed.text).toContain("helper stopped");
  expect((await call("screen_state", { app: "Calculator" })).text).toContain("6 text 0");
  expect(starts()).toBe(2);
});

it("an app that never answers times out and does not block later calls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ace-computer-hang-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const { call, starts } = await world({ FAKE_HANG_ONCE: join(dir, "hung") }, 1_500);
  await call("screen_state", { app: "Calculator" });
  const stuck = await call("screen_act", {
    app: "Calculator",
    actions: [{ type: "key", key: "Escape" }],
  });
  expect(stuck.result.isError).toBe(true);
  expect(stuck.text).toContain("did not respond in time");
  const after = await call("screen_act", {
    app: "Calculator",
    actions: [{ type: "key", key: "Escape" }],
  });
  expect(after.text).toContain("1. did key");
  expect(starts()).toBe(2);
});

it("a screenshot arrives as an image with its coordinate space explained", async () => {
  const { call } = await world();
  const { result, text } = await call("screen_state", { app: "Calculator", screenshot: true });
  expect(
    result.content.some((part) => part.type === "image" && part.mimeType === "image/jpeg"),
  ).toBe(true);
  expect(text).toContain("Screenshot: 674×408 px. Click coordinates are pixels in this image.");
});

it("a shortcut that changed nothing tells the agent to use a control or bring the app forward", async () => {
  const { call } = await world();
  await call("screen_state", { app: "Calculator" });
  const ignored = await call("screen_act", {
    app: "Calculator",
    actions: [{ type: "key", key: "cmd+s" }],
  });
  expect(ignored.text).toContain("No change since your last look.");
  expect(ignored.text).toContain("That had no visible effect.");
});
