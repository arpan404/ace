import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";
import { FakeHeadless } from "@ace/browser/testing";
import { Agent, AgentId, type ThreadId } from "@ace/protocol";
import { BackendConnection } from "../../desktop/src/main/browser/connection.ts";
import { BrowserBackend } from "../../desktop/src/main/browser/backend.ts";
import { readDesktopCredential } from "../../desktop/src/main/browser/credential.ts";
import { fakeViews } from "../../desktop/src/main/browser/test-support.ts";
import { invoke } from "./browser-mcp-test-support.ts";
import { startDaemon } from "./index.ts";
import { readConfig } from "./config.ts";
import { createDevThread } from "./commands.ts";

const Result = z.object({
  result: z.object({
    content: z.array(z.object({ type: z.string(), data: z.string().optional() }).loose()),
    isError: z.boolean().optional(),
  }),
});

/** A real daemon (settings, MCP, desktop relay) with the desktop's real backend over fake views. */
async function setup() {
  const home = await mkdtemp(join(tmpdir(), "ace-native-selection-"));
  const headless = new FakeHeadless();
  const daemon = await startDaemon({
    config: readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
    browser: { headlessBackend: headless },
  });
  const views = fakeViews();
  const connection = new BackendConnection(new BrowserBackend(views.host, { log() {} }), {
    daemon: async () => ({ url: daemon.url, token: await readFile(daemon.tokenPath, "utf8") }),
    credential: () => readDesktopCredential(home),
    socket: (url) => new WebSocket(url),
    timers: {
      set(delay, work) {
        const timer = setTimeout(work, delay);
        return () => clearTimeout(timer);
      },
    },
    id: randomUUID,
    log() {},
  });
  onTestFinished(async () => {
    connection.close();
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  });
  const desktop = async (available: boolean) => {
    connection.setAvailable(available);
    await vi.waitFor(() => expect(connection.state()).toBe(available ? "registered" : "off"));
  };
  const workspaceId = daemon.store.createWorkspace(home, "Test");
  const thread = createDevThread(daemon.store, workspaceId);
  daemon.store.appendEvents(thread.id, [
    {
      type: "agent.created",
      agent: Agent.parse({
        id: "root",
        threadId: thread.id,
        parentId: null,
        origin: "root",
        native: { provider: "codex" },
        fidelity: "full",
        cwd: home,
        status: { state: "working", activity: "tool" },
        createdAt: 1,
      }),
    },
  ]);
  const lease = daemon.mcp.openSession(
    {
      sessionId: "agent",
      threadId: thread.id,
      agentId: AgentId.parse("root"),
      capabilities: ["browser"],
    },
    new AbortController().signal,
  );
  onTestFinished(() => lease.end());
  /** An agent's browser tool call, through the daemon's real MCP endpoint. */
  const tool = async (name: string, args: unknown = {}) => {
    const response = await invoke({ url: daemon.mcp.url, bearer: lease.bearer }, name, args);
    const result = Result.parse(await response.json()).result;
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return result;
  };
  return { daemon, headless, views, desktop, thread, workspaceId, tool };
}

const deleteThread = (daemon: Awaited<ReturnType<typeof startDaemon>>, id: ThreadId) =>
  daemon.store.appendEvents(id, [{ type: "thread.client.updated", changes: { deletedAt: 5 } }]);

it("auto opens the desktop's native page for people and agents alike", async () => {
  const f = await setup();
  await f.desktop(true);
  // No preference override: the daemon resolves `browser.backend` from its settings (auto).
  expect(
    await f.daemon.browser.open({ threadId: f.thread.id, workspaceId: f.workspaceId }),
  ).toMatchObject({
    backend: "embedded",
  });
  await f.daemon.browser.closeThread(f.thread.id);
  await f.tool("ace_browser_open");
  expect(f.daemon.browser.state(f.thread.id)).toMatchObject({ backend: "embedded" });
  expect(f.headless.pages).toHaveLength(0);
  // Thread browsers keep their own persistent profile unless the settings say otherwise.
  expect(f.views.opened.map((options) => options.profile)).toEqual(["persistent", "persistent"]);
});

it("agent browser tools navigate, press and screenshot in the desktop's native view", async () => {
  const f = await setup();
  await f.desktop(true);
  await f.tool("ace_browser_open", { url: "http://127.0.0.1:4100/agent" });
  const page = f.views.only();
  expect(page.url()).toBe("http://127.0.0.1:4100/agent");
  await f.tool("ace_browser_press", { key: "Enter" });
  expect(page.calls).toContainEqual({ method: "press", params: { key: "Enter" } });
  page.results.set("Page.getLayoutMetrics", {
    cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 720 },
  });
  page.results.set("Runtime.evaluate", { result: { value: 1 } });
  const shot = await f.tool("ace_browser_screenshot");
  expect(shot.content).toContainEqual(expect.objectContaining({ type: "image" }));
  expect(page.calls.some((call) => call.method === "Page.captureScreenshot")).toBe(true);
  expect(f.headless.pages).toHaveLength(0);
});

it("without a desktop agent tools run headless, and a desktop that connects later keeps that page", async () => {
  const f = await setup();
  await f.tool("ace_browser_open", { url: "http://127.0.0.1:4100/headless" });
  expect(f.daemon.browser.state(f.thread.id)).toMatchObject({ backend: "headless" });
  await f.desktop(true);
  // The person opening the thread's browser on the desktop sees the agent's page as it is.
  expect(
    await f.daemon.browser.open({ threadId: f.thread.id, workspaceId: f.workspaceId }),
  ).toMatchObject({
    backend: "headless",
    url: "http://127.0.0.1:4100/headless",
  });
  expect(f.views.pages.size).toBe(0);
  expect(f.headless.pages).toHaveLength(1);
});

it("agent work continues headlessly at the last URL when the desktop closes mid-task", async () => {
  const f = await setup();
  await f.desktop(true);
  await f.tool("ace_browser_open", { url: "http://127.0.0.1:4100/task" });
  await f.desktop(false);
  await vi.waitFor(() =>
    expect(f.daemon.browser.state(f.thread.id)).toMatchObject({ status: "paused" }),
  );
  await f.tool("ace_browser_scroll", { x: 0, y: 200 });
  expect(f.daemon.browser.state(f.thread.id)).toMatchObject({
    backend: "headless",
    url: "http://127.0.0.1:4100/task",
  });
  expect(f.headless.pages.map((page) => page.url)).toEqual(["http://127.0.0.1:4100/task"]);
});

it("deleting a thread purges its desktop partition now, or when the desktop next registers", async () => {
  const f = await setup();
  await f.desktop(true);
  await f.tool("ace_browser_open");
  deleteThread(f.daemon, f.thread.id);
  await vi.waitFor(() => expect(f.views.purged).toHaveLength(1));
  expect(f.views.purged[0]).toEqual({ threadId: f.thread.id, workspaceId: f.workspaceId });
  expect(f.views.only().closed).toBe(true);

  const later = createDevThread(f.daemon.store, f.workspaceId);
  await f.desktop(false);
  deleteThread(f.daemon, later.id);
  await f.desktop(true);
  await vi.waitFor(() =>
    expect(f.views.purged).toContainEqual({ threadId: later.id, workspaceId: f.workspaceId }),
  );
});
