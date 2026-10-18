import { PublicToolError } from "@ace/mcp-server/errors";
import { z } from "zod";
import { ThreadId } from "@ace/protocol";
import {
  agentBrowserError,
  browserChoiceInput,
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
 * The person's own Chrome (ADR 0084): a thread's browser there, over the tabs agents open in
 * its ace window and the tabs the person shared. `available` is whether a browser is connected.
 */
export interface UserBrowserTools {
  sessions: BrowserService;
  available(): boolean;
}

/**
 * Trusted MCP attribution chooses the thread; agents cannot supply another thread id. With a
 * route, every tool also takes `machine` to act in another paired machine's browser instead;
 * with `user`, `browser: "user"` to act in the person's own Chrome.
 */
export function browserToolkit(
  browser: BrowserService,
  store: Store,
  route?: BrowserMachineRoute,
  user?: UserBrowserTools,
): Toolkit {
  /** The service a call's `browser` names. The person's Chrome never stands in for ace's. */
  const pick = (choice: "ace" | "user" | undefined): BrowserService => {
    if (choice !== "user") return browser;
    if (!user?.available()) throw new PublicToolError("user_browser_unavailable");
    return user.sessions;
  };
  const open = async (threadId: ThreadId, service = browser) => {
    const thread = store.getThread(threadId);
    if (!thread) throw new Error("Browser thread unavailable");
    await service.open({ threadId, workspaceId: thread.workspaceId, background: true });
  };
  // Only a daemon that can reach other machines accepts `machine`; elsewhere it is refused.
  const elsewhere = (target: string | undefined) => {
    if (target !== undefined && !route) throw new PublicToolError("machine_unavailable");
    return route && target !== undefined ? route : undefined;
  };

  /** Opens the thread's browser in `service` before each call, as an agent's first call. */
  const opened = (choice: "ace" | "user") => {
    const service = pick(choice);
    return {
      async execute(...[threadId, command, actor, signal]: Parameters<BrowserService["execute"]>) {
        signal?.throwIfAborted();
        await open(ThreadId.parse(threadId), service);
        signal?.throwIfAborted();
        return service.execute(threadId, command, actor, signal);
      },
      async screenshot(
        ...[threadId, signal, tabId, options, actor]: Parameters<BrowserService["screenshot"]>
      ) {
        signal?.throwIfAborted();
        await open(ThreadId.parse(threadId), service);
        signal?.throwIfAborted();
        return service.screenshot(threadId, signal, tabId, options, actor);
      },
      async capture(
        ...[threadId, signal, tabId, options, actor]: Parameters<BrowserService["capture"]>
      ) {
        signal?.throwIfAborted();
        await open(ThreadId.parse(threadId), service);
        signal?.throwIfAborted();
        return service.capture(threadId, signal, tabId, options, actor);
      },
    };
  };
  return {
    register(registry) {
      registry.registerContent({
        name: "ace_browser_open",
        description:
          "Open this thread's ace browser, which the person can watch and take over in ace, at an optional HTTP(S) url (localhost included). Returns tabId. newTab opens your own tab (give it a label); parallel agents must each open a labelled tab and pass its tabId to every ace_browser_* call. The best pick when the person should see the page, or you need console and network evidence (ace_browser_logs). Then ace_browser_snapshot for element refs. browser \"user\" works in the person's own Chrome instead, signed in as them; pass the same browser to every later call for that page. More: ace_guide ace-browser.",
        input: z.strictObject({
          url: z.string().max(8192).optional(),
          newTab: z.boolean().default(false),
          label: z
            .string()
            .min(1)
            .max(64)
            .optional()
            .describe("A short name for a new tab, such as checkout or admin."),
          keep: z
            .boolean()
            .optional()
            .describe(
              "With newTab: keep the tab after your turn (a deliverable or handoff). Tabs you open are otherwise temporary.",
            ),
          ...browserMachineInput,
          ...browserChoiceInput,
        }),
        capability: "browser",
        timeoutMs: 300_000,
        async run(input, context) {
          const { caller, signal } = context;
          signal.throwIfAborted();
          const { machine: target, browser: choice, ...args } = input;
          if (choice === "user" && target !== undefined)
            throw new PublicToolError("user_browser_unavailable");
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
          const service = pick(choice);
          try {
            await open(caller.threadId, service);
            signal.throwIfAborted();
            const actor = { kind: "agent" as const, agentId: caller.agentId };
            if (args.newTab) {
              await service.execute(
                caller.threadId,
                {
                  action: "tabs",
                  operation: "open",
                  url: args.url,
                  label: args.label,
                  keep: args.keep,
                },
                actor,
                signal,
              );
              return content({
                ...service.state(caller.threadId),
                ...tabSummary(service.currentTab(caller.threadId, actor)),
              });
            }
            const current = await service.claimTab(caller.threadId, actor);
            if (args.url !== undefined)
              await service.execute(
                caller.threadId,
                { action: "navigate", url: args.url, tabId: current.tabId },
                actor,
                signal,
              );
            return content({
              ...service.state(caller.threadId),
              ...tabSummary(service.currentTab(caller.threadId, actor)),
            });
          } catch (error) {
            throw agentBrowserError(error);
          }
        },
      });
      scopedBrowserToolkit(
        {
          execute: (...call) => opened("ace").execute(...call),
          screenshot: (...call) => opened("ace").screenshot(...call),
          capture: (...call) => opened("ace").capture(...call),
        },
        200_000,
        route,
        user ? () => opened("user") : undefined,
      ).register(registry);
      registry.registerContent({
        name: "ace_browser_close",
        description:
          "Close one tab with tabId (close the tabs you opened when done), or without tabId the whole browser and every tab in it.",
        input: z.strictObject({
          tabId: z.string().min(1).max(256).optional(),
          ...browserMachineInput,
          ...browserChoiceInput,
        }),
        capability: "browser",
        timeoutMs: 60_000,
        async run(input, context) {
          const { caller, signal } = context;
          signal.throwIfAborted();
          const choice = input.browser;
          if (choice === "user" && input.machine !== undefined)
            throw new PublicToolError("user_browser_unavailable");
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
          // Closing only ends what is open: the person's browser need not be connected.
          const service = choice === "user" && user ? user.sessions : pick(choice);
          if (input.tabId !== undefined) {
            await service.execute(
              caller.threadId,
              { action: "tabs", operation: "close", tabId: input.tabId },
              actor,
              signal,
            );
            return content({ closed: true, tabId: input.tabId });
          }
          await service.closeThread(caller.threadId, actor, signal);
          return content({ closed: true });
        },
      });
    },
  };
}
