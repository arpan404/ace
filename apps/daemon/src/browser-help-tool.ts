import type { BrowserService } from "@ace/browser";
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
export function browserHelpToolkit(help: BrowserHelp): Toolkit {
  return {
    register(registry) {
      registry.register({
        name: "browser_request_help",
        title: "Ask the person to act in a tab",
        riskClass: "thread-write",
        description:
          "Ask the person to sign in, solve a CAPTCHA, enter a two-factor code or answer a dialog in a browser tab, when only they can (login, captcha, two_factor, dialog). ace shows the request, notifies them and opens the tab for them; it waits up to timeoutSeconds (at most 240). done: they finished, snapshot the tab and carry on. skipped: they won't, so work around it. pending: end your turn; their answer arrives as their next message. Never type credentials or codes yourself.",
        input: BrowserHelpInput,
        output: BrowserHelpResult,
        capability: "browser",
        timeoutMs: 250_000,
        run: (input, { caller, signal }) => help.request(caller, input, signal),
      });
    },
  };
}
