import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { Agent, AgentId, type ThreadId } from "@ace/protocol";
import { BrowserService, detectChromium, type BrowserServiceOptions } from "@ace/browser";
import { Store } from "./store.ts";
import { createDevThread } from "./commands.ts";
import { startDaemonMcp } from "./mcp.ts";
import { browserToolkit } from "./browser-toolkit.ts";
import { SqliteBrowserTabStore } from "./browser-tab-store.ts";
import { invoke, Result } from "./browser-mcp-test-support.ts";

const executablePath = await detectChromium();
/** The tab and the Name field's ref from compact snapshot text. */
function snapshotOf(text: string) {
  const tabId = text.match(/\[tab=([^\]]+)\]/)?.[1];
  const name = text.match(/- textbox "Name" \[ref=([^\]]+)\]/)?.[1];
  if (!tabId || !name) throw new Error(`No tab or Name field in snapshot:\n${text}`);
  return { tabId, name };
}
const Opened = z.object({ tabId: z.string() });

/** A local page with a text field and a cookie it can set. */
async function site() {
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(
      `<!doctype html><title>${request.url}</title><label>Name <input aria-label="Name"></label>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${address.port}`;
}

async function daemon(home: string, options: Partial<BrowserServiceOptions> = {}) {
  const store = new Store(join(home, "store.sqlite"));
  const browser = new BrowserService({
    dataDir: home,
    ...(executablePath ? { executablePath } : {}),
    tabStore: new SqliteBrowserTabStore((sql) => store.statement(sql)),
    ...options,
  });
  return {
    store,
    browser,
    async stop() {
      await browser.close();
      store.close();
    },
  };
}

function agent(threadId: ThreadId, id: string, parentId: string | null) {
  return Agent.parse({
    id,
    threadId,
    parentId,
    origin: parentId ? "provider_subagent" : "root",
    native: { provider: "codex" },
    fidelity: "full",
    cwd: "/repo",
    status: { state: "idle" },
    createdAt: 1,
  });
}

describe.skipIf(!executablePath)("browser tabs through the daemon", () => {
  it("two agents' MCP calls go to the tabs they opened, by tabId or by their own current tab", async () => {
    const home = await mkdtemp(join(tmpdir(), "ace-browser-tabs-"));
    onTestFinished(() => rm(home, { recursive: true, force: true }));
    const url = await site();
    const d = await daemon(home);
    onTestFinished(() => d.stop());
    const thread = createDevThread(d.store, d.store.createWorkspace(home, "Tabs"));
    d.store.appendEvents(thread.id, [
      { type: "agent.created", agent: agent(thread.id, "root", null) },
      { type: "agent.created", agent: agent(thread.id, "child", "root") },
    ]);
    const mcp = await startDaemonMcp(d.store, [browserToolkit(d.browser, d.store)]);
    onTestFinished(() => mcp.close());
    const connect = (agentId: string) => {
      const lease = mcp.openSession(
        {
          sessionId: agentId,
          threadId: thread.id,
          agentId: AgentId.parse(agentId),
          capabilities: ["browser"],
        },
        new AbortController().signal,
      );
      const text = async (name: string, args: unknown = {}) => {
        const result = Result.parse(
          await (await invoke({ url: mcp.url, bearer: lease.bearer }, name, args)).json(),
        ).result;
        const body = result.content[0]?.text ?? "null";
        if (result.isError) throw new Error(body);
        return body;
      };
      return Object.assign(
        async (name: string, args: unknown = {}) => JSON.parse(await text(name, args)) as unknown,
        { text },
      );
    };
    const root = connect("root"),
      child = connect("child");
    const rootTab = Opened.parse(await root("browser_open", { url: `${url}/root` })).tabId;
    const childTab = Opened.parse(
      await child("browser_tabs", { action: "open", url: `${url}/child`, label: "checkout" }),
    ).tabId;
    expect(childTab).not.toBe(rootTab);
    const fill = async (call: typeof root, tabId: string | undefined, text: string) => {
      const snapshot = snapshotOf(await call.text("browser_snapshot", tabId ? { tabId } : {}));
      await call("browser_act", {
        ...(tabId ? { tabId } : {}),
        action: "type",
        ref: snapshot.name,
        text,
      });
      return snapshot.tabId;
    };
    // The root names its tab; the child relies on its own current tab.
    const [rootSaw, childSaw] = await Promise.all([
      fill(root, rootTab, "from root"),
      fill(child, undefined, "from child"),
    ]);
    expect([rootSaw, childSaw]).toEqual([rootTab, childTab]);
    const value = (tabId: string) =>
      root("browser_evaluate", { tabId, expression: "document.querySelector('input').value" });
    expect(await value(rootTab)).toBe("from root");
    expect(await value(childTab)).toBe("from child");
    const listed = z
      .object({
        tabs: z.array(
          z.object({
            tabId: z.string(),
            label: z.string().optional(),
            current: z.boolean().optional(),
            openedBy: z.object({ kind: z.string(), agentId: z.string().optional() }).optional(),
          }),
        ),
      })
      .parse(await child("browser_tabs", { action: "list" }));
    expect(listed.tabs.find((tab) => tab.tabId === childTab)).toMatchObject({
      label: "checkout",
      current: true,
      openedBy: { kind: "agent", agentId: "child" },
    });
    await child("browser_tabs", { action: "close", tabId: childTab });
    expect(d.browser.state(thread.id).tabs?.map((tab) => tab.tabId)).toEqual([rootTab]);
    await expect(child.text("browser_snapshot", { tabId: childTab })).rejects.toThrow(
      "tab_not_found",
    );
  }, 90_000);

  it("a restarted daemon brings a thread's tabs back with the same ids, labels, privacy, keeps and cookies", async () => {
    const home = await mkdtemp(join(tmpdir(), "ace-browser-restore-"));
    onTestFinished(() => rm(home, { recursive: true, force: true }));
    const url = await site();
    const first = await daemon(home);
    const thread = createDevThread(first.store, first.store.createWorkspace(home, "Restore"));
    const open = (d: typeof first) =>
      d.browser.open({
        threadId: thread.id,
        workspaceId: thread.workspaceId,
        profile: "persistent",
      });
    await open(first);
    const worker = { kind: "agent" as const, agentId: "worker" };
    const main = first.browser.state(thread.id).activeTabId;
    await first.browser.execute(thread.id, { action: "navigate", url: `${url}/main` }, worker);
    await first.browser.execute(
      thread.id,
      { action: "evaluate", expression: "document.cookie = 'kept=yes; max-age=3600'" },
      worker,
    );
    const side = Opened.parse(
      await first.browser.execute(
        thread.id,
        { action: "tabs", operation: "open", url: `${url}/side`, label: "side", keep: true },
        worker,
      ),
    ).tabId;
    first.browser.setPrivate(thread.id, side, true);
    const before = first.browser.state(thread.id).tabs?.map((tab) => [tab.tabId, tab.url]);
    await first.stop();

    const second = await daemon(home);
    onTestFinished(() => second.stop());
    await open(second);
    const restored = second.browser.state(thread.id);
    expect(restored.tabs?.map((tab) => [tab.tabId, tab.url])).toEqual(before);
    expect(restored.tabs?.find((tab) => tab.tabId === side)).toMatchObject({
      label: "side",
      openedBy: { kind: "agent", agentId: "worker" },
      private: true,
      kept: true,
    });
    await expect(
      second.browser.execute(thread.id, { action: "snapshot", tabId: side }, worker),
    ).rejects.toMatchObject({ code: "human_private" });
    expect(
      await second.browser.execute(thread.id, {
        action: "evaluate",
        tabId: main,
        expression: "document.cookie",
      }),
    ).toContain("kept=yes");
    await second.browser.closeThread(thread.id);
    await open(second);
    expect(second.browser.state(thread.id).tabs).toHaveLength(1);
  }, 120_000);
});
