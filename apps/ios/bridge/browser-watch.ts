import type { BrowserState } from "@ace/protocol";
import { z } from "zod";

/*
 * Watch mode, as web's ⋯ menu offers it: the browser follows the agent from tab to tab until the
 * thread's agents stop working or the person leaves the browser. Pure: `BrowserLive` feeds it
 * browser states and the thread's status, and selects the tab it names.
 */

export const WatchAction = z.object({ kind: z.literal("watch"), on: z.boolean() });
export type WatchAction = z.infer<typeof WatchAction>;

/** The tab an agent works in now: the shown tab when an agent uses it, else the first. */
export function agentTab(state: BrowserState | undefined): string | undefined {
  if (!state || state.closed) return undefined;
  const used = (state.tabs ?? []).filter((tab) => tab.inUse?.kind === "agent");
  return (used.find((tab) => tab.tabId === state.activeTabId) ?? used[0])?.tabId;
}

/** The agents stopped: the run ended, failed, or waits on the person or on something outside. */
const finished = (state: string | undefined) => state !== undefined && state !== "working";

export class BrowserWatch {
  #threadId: string | undefined;
  #status: string | undefined;

  /** Whether watch mode is on for the thread: undefined when no agent browses, nothing to offer. */
  view(threadId: string, state: BrowserState | undefined): { on: boolean } | null {
    if (this.#threadId === threadId) return { on: true };
    return agentTab(state) ? { on: false } : null;
  }

  /** Turns watch mode on or off; on answers the tab to show, the agent's. */
  set(
    threadId: string,
    state: BrowserState | undefined,
    on: boolean,
    status: string | undefined,
  ): string | undefined {
    if (!on) {
      this.stop();
      return undefined;
    }
    const target = agentTab(state);
    if (!target) return undefined;
    this.#threadId = threadId;
    this.#status = status;
    return target === state?.activeTabId ? undefined : target;
  }

  /** A new browser state: the tab to show when the agent moved to another, else undefined. */
  follow(threadId: string, state: BrowserState): string | undefined {
    if (this.#threadId !== threadId) return undefined;
    const target = agentTab(state);
    return target && target !== state.activeTabId ? target : undefined;
  }

  /** The thread's status changed; true when watch mode ended because the agents stopped. */
  status(threadId: string, status: string | undefined): boolean {
    if (this.#threadId !== threadId) return false;
    const was = this.#status;
    this.#status = status;
    if (finished(status) && !finished(was)) {
      this.stop();
      return true;
    }
    return false;
  }

  stop(): void {
    this.#threadId = undefined;
    this.#status = undefined;
  }
}
