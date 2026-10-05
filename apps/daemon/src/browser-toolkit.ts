import { PublicToolError } from "@ace/mcp-server/errors";
import { z } from "zod";
import { ThreadId } from "@ace/protocol";
import { browserToolkit as scopedBrowserToolkit, type BrowserService } from "@ace/browser";
import type { Toolkit } from "@ace/mcp-server";
import type { Store } from "./store.ts";

const content = (value: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(value) ?? "null" }],
});

/** Trusted MCP attribution chooses the thread; agents cannot supply another thread id. */
export function browserToolkit(browser: BrowserService, store: Store): Toolkit {
  const open = async (threadId: ThreadId) => {
    const thread = store.getThread(threadId);
    if (!thread) throw new Error("Browser thread unavailable");
    await browser.open({ threadId, workspaceId: thread.workspaceId, background: true });
  };

  return {
    register(registry) {
      registry.registerContent({
        name: "ace_browser_open",
        description:
          "Open this thread's ace browser. Optional url must be HTTP(S) without credentials. New origins follow the thread permission mode and may wait for human approval. Then call ace_browser_snapshot for element refs. Do not use cua_repl or another provider's browser for this thread.",
        input: z.strictObject({
          url: z.string().max(8192).optional(),
          newTab: z.boolean().default(false),
        }),
        capability: "browser",
        timeoutMs: 300_000,
        async run(input, { caller, signal }) {
          signal.throwIfAborted();
          await open(caller.threadId);
          signal.throwIfAborted();
          if (browser.state(caller.threadId).takeoverMode === "private")
            throw new PublicToolError("human_private");
          if (input.newTab)
            return content(
              await browser.execute(
                caller.threadId,
                { action: "tabs", operation: "open", ...(input.url ? { url: input.url } : {}) },
                { kind: "agent" },
                signal,
              ),
            );
          return content(
            input.url === undefined
              ? browser.state(caller.threadId)
              : await browser.execute(
                  caller.threadId,
                  { action: "navigate", url: input.url },
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
      ).register(registry);
      registry.registerContent({
        name: "ace_browser_close",
        description: "Close this thread's ace browser.",
        input: z.strictObject({}),
        capability: "browser",
        timeoutMs: 60_000,
        async run(_input, { caller, signal }) {
          signal.throwIfAborted();
          await browser.closeThread(caller.threadId, { kind: "agent" }, signal);
          return content({ closed: true });
        },
      });
    },
  };
}
