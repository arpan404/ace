import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { BrowserService } from "@ace/browser";
import { CredentialRegistry, ToolRegistry } from "@ace/mcp-server";
import { McpScope, ThreadId } from "@ace/protocol";
import { browserHelpTab, browserHelpToolkit } from "./browser-help-tool.ts";
import { createDevThread } from "./commands.ts";
import { BrowserHelp } from "./browser-help.ts";
import type { Engine } from "./engine/index.ts";
import { Store } from "./store.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** Any use of the engine or the browser fails the test: the hot path must not reach them. */
const untouchable = new Proxy({} as Engine, {
  get() {
    throw new Error("the engine was used");
  },
});

function helpWithOneOpenRequest() {
  const home = mkdtempSync(join(tmpdir(), "ace-browser-help-"));
  homes.push(home);
  const store = new Store(join(home, "events.sqlite"));
  const deps = {
    store,
    engine: () => untouchable,
    tab: () => {
      throw new Error("the browser was asked");
    },
    id: () => "id",
    schedule: () => () => {},
  };
  // A request open on another thread, as a restart finds it (the first daemon made the table).
  const before = new BrowserHelp(deps);
  before.close();
  store.atomic((db) =>
    db
      .prepare("INSERT INTO browser_help_pending VALUES (?,?,?,?,?)")
      .run("ask-1", "thread-with-help", "key-1", "tab-1", "Sign in"),
  );
  const help = new BrowserHelp(deps);
  let transactions = 0;
  const atomic = store.atomic.bind(store);
  store.atomic = (run) => {
    transactions++;
    return atomic(run);
  };
  return { help, store, transactions: () => transactions };
}

it("an event on a thread with no browser-help request opens no transaction and reads no rows", async () => {
  const { help, store, transactions } = helpWithOneOpenRequest();
  const quiet = ThreadId.parse("thread-without-help");
  help.sweep(quiet);
  help.withdrawIdle(quiet, "agent-1");
  expect(transactions()).toBe(0);
  await store.close();
});

/** browser_request_help as an agent calls it, over the browser `current` returns. */
async function helpTool(current: () => BrowserService | undefined) {
  const home = mkdtempSync(join(tmpdir(), "ace-browser-help-"));
  homes.push(home);
  const store = new Store(join(home, "events.sqlite"));
  const thread = createDevThread(store, store.createWorkspace(home, "Repo"));
  const help = new BrowserHelp({
    store,
    engine: () => untouchable,
    tab: browserHelpTab(current),
    id: () => "id",
    schedule: () => () => {},
  });
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  browserHelpToolkit(help, undefined, current).register(registry);
  const credentials = new CredentialRegistry(() => "a".repeat(64));
  const lease = credentials.issue(
    McpScope.parse({
      sessionId: "s",
      threadId: thread.id,
      agentId: "root",
      capabilities: ["browser"],
    }),
    new AbortController().signal,
  );
  const call = async () => {
    const result = await registry.call(
      "browser_request_help",
      { tabId: "t1", reason: "login", message: "Sign in with the work account." },
      lease.principal,
      new AbortController().signal,
    );
    return result.content.map((part) => ("text" in part ? part.text : "")).join("\n");
  };
  return {
    call,
    close: async () => {
      help.close();
      credentials.close();
      await store.close();
    },
  };
}

it("asking for help while ace's browser is down says the browser is unavailable", async () => {
  const tool = await helpTool(() => undefined);
  expect(await tool.call()).toContain("browser_unavailable");
  await tool.close();
});

it("asking for help about a tab the running browser lacks says the tab is not found", async () => {
  // A browser with no tabs open: the tab asked about is not there.
  const browser = {
    state: (threadId: string) => ({ threadId, url: "", closed: false, tabs: [] }),
  } as unknown as BrowserService;
  const tool = await helpTool(() => browser);
  expect(await tool.call()).toContain("tab_not_found");
  await tool.close();
});
