import type { BrowserTab } from "@ace/protocol";
import type { TabCommand } from "./session-commands.ts";
import { mutatesBrowser } from "./session-queue.ts";

const signInHint =
  "This site asks for a sign-in (HTTP authentication). Only the person may sign in: tell them, and they answer the prompt in ace's Browser panel. Continue once pending_auth is gone from browser_tabs list.";

/** Leaving the page (a new address, back or forward) is always allowed; it drops the prompt. */
function leavesPage(command: TabCommand): boolean {
  return command.action === "navigate" || command.action === "history";
}

/** A site's sign-in holds its tab for every command but one that leaves the page. */
export function personHold(
  tab: BrowserTab | undefined,
  command?: TabCommand,
): Record<string, unknown> | undefined {
  if (!tab?.pending_auth || (command && leavesPage(command))) return undefined;
  return { pending_auth: tab.pending_auth, hint: signInHint };
}

/**
 * An agent may not act on a certificate warning page: proceeding past it is the person's call.
 * It may still read the page or leave it.
 */
export function refusesAgent(tab: BrowserTab | undefined, command: TabCommand): boolean {
  return tab?.certificate_error !== undefined && mutatesBrowser(command) && !leavesPage(command);
}
