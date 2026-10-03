import { z } from "zod";
import { BrowserCommand, type ThreadId } from "@ace/protocol";
import type { BrowserService } from "@ace/browser";
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
    await browser.open({ threadId, workspaceId: thread.workspaceId });
  };

  return {
    register(registry) {
      registry.registerContent({
        name: "ace_browser_open",
        description:
          "Open ace's browser in this thread, selecting the desktop or headless backend automatically.",
        input: z.object({ url: z.string().max(8192).optional() }),
        capability: "browser",
        timeoutMs: 300_000,
        async run(input, { caller, signal }) {
          signal.throwIfAborted();
          await open(caller.threadId);
          signal.throwIfAborted();
          return content(
            input.url === undefined
              ? browser.state(caller.threadId)
              : await browser.execute(caller.threadId, { action: "navigate", url: input.url }),
          );
        },
      });
      for (const schema of BrowserCommand.options) {
        const action = schema.shape.action.value;
        registry.registerContent({
          name: `ace_browser_${action}`,
          description: `Run ${action} in this thread's ace browser. Human control and origin/evaluate approvals apply.`,
          input: z.object({ ...schema.shape }).omit({ action: true }),
          capability: "browser",
          timeoutMs: 300_000,
          async run(input, { caller, signal }) {
            signal.throwIfAborted();
            await open(caller.threadId);
            signal.throwIfAborted();
            return content(await browser.execute(caller.threadId, { ...input, action }));
          },
        });
      }
      registry.registerContent({
        name: "ace_browser_close",
        description: "Close this thread's ace browser.",
        input: z.object({}),
        capability: "browser",
        timeoutMs: 60_000,
        async run(_input, { caller, signal }) {
          signal.throwIfAborted();
          await browser.closeThread(caller.threadId);
          return content({ closed: true });
        },
      });
    },
  };
}
