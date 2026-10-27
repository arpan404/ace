import type { BrowserService } from "@ace/browser";
import { z } from "zod";
import type { BrowserMachineRoute } from "@ace/browser";
import type { Toolkit } from "@ace/mcp-server";
import type { ThreadId } from "@ace/protocol";
import {
  BrowserHelpInput,
  BrowserHelpResult,
  type BrowserHelp,
  type BrowserHelpTab,
} from "./browser-help.ts";

/**
 * A tab of the thread's ace browser, as the agent may name it. A backend without a tab list
 * holds one page, which is the agent's current tab. Private tabs are never offered.
 */
export function browserHelpTab(browser: BrowserService): BrowserHelpTab {
  return (threadId: ThreadId, tabId: string, agentId: string) => {
    try {
      const tabs = browser.state(threadId).tabs;
      if (tabs) {
        const tab = tabs.find((each) => each.tabId === tabId);
        return tab && !tab.private ? { url: tab.url, title: tab.title } : undefined;
      }
      const only = browser.currentTab(threadId, { kind: "agent", agentId });
      return only.tabId === tabId ? { url: only.url, title: only.title } : undefined;
    } catch {
      // The thread's browser is not open.
      return undefined;
    }
  };
}

/** `browser_request_help`, beside the browser tools (ADR 0067, collaboration). */
export function browserHelpToolkit(help: BrowserHelp, route?: BrowserMachineRoute): Toolkit {
  return {
    register(registry) {
      registry.registerContent({
        name: "browser_request_help",
        title: "Ask the person to act in a tab",
        riskClass: "thread-write",
        description:
          "Ask the person to sign in, solve a CAPTCHA, enter a code or answer a dialog in a tab; never type credentials yourself. skipped: work around it. pending: end your turn; their answer comes as a message.",
        input: route
          ? BrowserHelpInput.extend({
              machine: z
                .string()
                .regex(/^[a-zA-Z0-9_.-]{1,64}$/)
                .optional(),
            })
          : BrowserHelpInput,
        capability: "browser",
        timeoutMs: 250_000,
        run: async (input, context) => {
          const { machine, ...args } = z
            .object({ machine: z.string().optional() })
            .passthrough()
            .parse(input);
          if (route && machine)
            return route(
              { machine, tool: "browser_request_help", args, timeoutMs: 245_000 },
              context,
            );
          const result = BrowserHelpResult.parse(
            await help.request(context.caller, BrowserHelpInput.parse(args), context.signal),
          );
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        },
      });
    },
  };
}
