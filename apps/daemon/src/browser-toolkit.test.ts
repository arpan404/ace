import { afterEach, expect, it } from "vitest";
import type { BrowserService } from "@ace/browser";
import { CredentialRegistry, ToolRegistry } from "@ace/mcp-server";
import { McpScope } from "@ace/protocol";
import { liveBrowserToolkit } from "./browser-toolkit.ts";
import { createDevThread } from "./commands.ts";
import { Store } from "./store.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

/** A browser service that records the commands it ran; `open` waits for `opened`. */
function stubBrowser(name: string, opened: Promise<void> = Promise.resolve()) {
  const ran: string[] = [];
  const browser = {
    open: () => opened,
    execute: async () => {
      ran.push(name);
      return { ok: true };
    },
    state: (threadId: string) => ({ threadId, url: "about:blank", closed: false }),
    currentTab: () => ({ tabId: "t1", url: "about:blank", title: "" }),
  };
  // A call reads nothing else from the service.
  return { browser: browser as unknown as BrowserService, ran };
}

async function tools(current: () => BrowserService | undefined) {
  const store = new Store(":memory:");
  cleanups.push(() => store.close());
  const thread = createDevThread(store, store.createWorkspace("/tmp", "Repo"));
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  liveBrowserToolkit(current, store).register(registry);
  const credentials = new CredentialRegistry(() => "a".repeat(64));
  cleanups.push(() => credentials.close());
  const lease = credentials.issue(
    McpScope.parse({
      sessionId: "s",
      threadId: thread.id,
      agentId: "root",
      capabilities: ["browser"],
    }),
    new AbortController().signal,
  );
  return (name: string, args: Record<string, unknown>) =>
    registry.call(name, args, lease.principal, new AbortController().signal);
}

const text = (result: { content: { type: string; text?: string }[] }) =>
  result.content.map((part) => part.text ?? "").join("\n");

it("a call while ace's browser is down says it is unavailable", async () => {
  const call = await tools(() => undefined);
  const result = await call("browser_snapshot", {});
  expect(result.isError).toBe(true);
  expect(text(result)).toContain("browser_unavailable");
});

it("a browser replaced while a call opened it refuses the call instead of running it in the new one", async () => {
  const opening = Promise.withResolvers<void>();
  const first = stubBrowser("first", opening.promise);
  const second = stubBrowser("second");
  let current = first.browser;
  const call = await tools(() => current);
  const pending = call("browser_snapshot", {});
  await new Promise((resolve) => setImmediate(resolve));
  current = second.browser;
  opening.resolve();
  const result = await pending;
  expect(result.isError).toBe(true);
  expect(text(result)).toContain("browser_restarted");
  expect(first.ran).toEqual([]);
  expect(second.ran).toEqual([]);
});
