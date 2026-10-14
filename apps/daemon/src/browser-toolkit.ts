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
          "Use for every website or web app, including localhost, instead of Safari or Chrome via screen_*. Open this thread's ace browser. Optional url must be HTTP(S) without credentials. Then call ace_browser_snapshot for element refs. Do not use cua_repl or another provider's browser for this thread.",
        input: z.strictObject({
          url: z.string().max(8192).optional(),
          newTab: z.boolean().default(false),
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
          if (browser.state(caller.threadId).takeoverMode === "private")
            throw new PublicToolError("human_private");
          return content(
            args.url === undefined
              ? browser.state(caller.threadId)
              : await browser.execute(
                  caller.threadId,
                  { action: "navigate", url: args.url },
                  { kind: "agent" },
                  signal,
                ),
          );
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
          async screenshot(threadId, signal, tabId) {
            signal?.throwIfAborted();
            await open(ThreadId.parse(threadId));
            signal?.throwIfAborted();
            return browser.screenshot(threadId, signal, tabId);
          },
        },
        200_000,
        route,
      ).register(registry);
      registry.registerContent({
        name: "ace_browser_close",
        description: "Close this thread's ace browser.",
        input: z.strictObject({ ...browserMachineInput }),
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
                args: {},
                timeoutMs: 55_000,
              },
              context,
            );
          await browser.closeThread(caller.threadId, { kind: "agent" }, signal);
          return content({ closed: true });
        },
      });
    },
  };
}
