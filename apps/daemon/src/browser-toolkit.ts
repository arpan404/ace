import { PublicToolError } from "@ace/mcp-server/errors";
import { z } from "zod";
import { ThreadId } from "@ace/protocol";
import {
  browserMachineInput,
  browserToolkit as scopedBrowserToolkit,
  type BrowserMachineRoute,
  type BrowserService,
} from "@ace/browser";
import type { Toolkit } from "@ace/mcp-server";
import type { Store } from "./store.ts";

const content = (value: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(value) ?? "null" }],
});
/** What an agent needs back from opening: the tab it now works in. */
const tabSummary = (tab: { tabId: string; url: string; title: string }) => ({
  tabId: tab.tabId,
  url: tab.url,
  title: tab.title,
});

/**
 * Trusted MCP attribution chooses the thread; agents cannot supply another thread id. With a
 * route, every tool also takes `machine` to act in another paired machine's browser instead.
 */
export function browserToolkit(
  browser: BrowserService,
  store: Store,
  route?: BrowserMachineRoute,
): Toolkit {
  const open = async (threadId: ThreadId) => {
    const thread = store.getThread(threadId);
    if (!thread) throw new Error("Browser thread unavailable");
    await browser.open({ threadId, workspaceId: thread.workspaceId, background: true });
  };
  // Only a daemon that can reach other machines accepts `machine`; elsewhere it is refused.
  const elsewhere = (target: string | undefined) => {
    if (target !== undefined && !route) throw new PublicToolError("machine_unavailable");
    return route && target !== undefined ? route : undefined;
  };

  return {
    register(registry) {
      registry.registerContent({
        name: "ace_browser_open",
        description:
          "Open this thread's ace browser, which the person can watch and take over in ace, at an optional HTTP(S) url (localhost included). Returns tabId. newTab opens your own tab (give it a label); parallel agents must each open a labelled tab and pass its tabId to every ace_browser_* call. The best pick when the person should see the page, or you need console and network evidence (ace_browser_logs). Then ace_browser_snapshot for element refs. More: ace_guide ace-browser.",
        input: z.strictObject({
          url: z.string().max(8192).optional(),
          newTab: z.boolean().default(false),
          label: z
            .string()
            .min(1)
            .max(64)
            .optional()
            .describe("A short name for a new tab, such as checkout or admin."),
          ...browserMachineInput,
        }),
        capability: "browser",
        timeoutMs: 300_000,
        async run(input, context) {
          const { caller, signal } = context;
          signal.throwIfAborted();
          const { machine: target, ...args } = input;
          const remote = elsewhere(target);
          if (remote && target)
            return remote(
              {
                machine: target,
                tool: "ace_browser_open",
                args,
                timeoutMs: 295_000,
              },
              context,
            );
          await open(caller.threadId);
          signal.throwIfAborted();
          const actor = { kind: "agent" as const, agentId: caller.agentId };
          if (args.newTab) {
            await browser.execute(
              caller.threadId,
              { action: "tabs", operation: "open", url: args.url, label: args.label },
              actor,
              signal,
            );
            return content({
              ...browser.state(caller.threadId),
              ...tabSummary(browser.currentTab(caller.threadId, actor)),
            });
          }
          const current = await browser.claimTab(caller.threadId, actor);
          if (args.url !== undefined)
            await browser.execute(
              caller.threadId,
              { action: "navigate", url: args.url, tabId: current.tabId },
              actor,
              signal,
            );
          return content({
            ...browser.state(caller.threadId),
            ...tabSummary(browser.currentTab(caller.threadId, actor)),
          });
        },
      });
      scopedBrowserToolkit(
        {
          async execute(threadId, command, actor, signal) {
            signal?.throwIfAborted();
            await open(ThreadId.parse(threadId));
            signal?.throwIfAborted();
            return browser.execute(threadId, command, actor, signal);
          },
          async screenshot(threadId, signal, tabId, options, actor) {
            signal?.throwIfAborted();
            await open(ThreadId.parse(threadId));
            signal?.throwIfAborted();
            return browser.screenshot(threadId, signal, tabId, options, actor);
          },
        },
        200_000,
        route,
      ).register(registry);
      registry.registerContent({
        name: "ace_browser_close",
        description:
          "Close one tab with tabId (close the tabs you opened when done), or without tabId the whole browser and every tab in it.",
        input: z.strictObject({
          tabId: z.string().min(1).max(256).optional(),
          ...browserMachineInput,
        }),
        capability: "browser",
        timeoutMs: 60_000,
        async run(input, context) {
          const { caller, signal } = context;
          signal.throwIfAborted();
          const remote = elsewhere(input.machine);
          if (remote && input.machine)
            return remote(
              {
                machine: input.machine,
                tool: "ace_browser_close",
                args: input.tabId ? { tabId: input.tabId } : {},
                timeoutMs: 55_000,
              },
              context,
            );
          const actor = { kind: "agent" as const, agentId: caller.agentId };
          if (input.tabId !== undefined) {
            await browser.execute(
              caller.threadId,
              { action: "tabs", operation: "close", tabId: input.tabId },
              actor,
              signal,
            );
            return content({ closed: true, tabId: input.tabId });
          }
          await browser.closeThread(caller.threadId, actor, signal);
          return content({ closed: true });
        },
      });
    },
  };
}
