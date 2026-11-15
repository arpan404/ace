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

  /**
   * Whether watch mode is on for the thread; null when there is nothing to watch: no agent
   * browses, or the thread's agents have stopped (their tab may still carry their mark).
   */
  view(
    threadId: string,
    state: BrowserState | undefined,
    status: string | undefined,
  ): { on: boolean } | null {
    if (this.#threadId === threadId) return { on: true };
    return agentTab(state) && !finished(status) ? { on: false } : null;
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
    // Agents that already stopped have nothing more to show.
    if (!target || finished(status)) return undefined;
    this.#threadId = threadId;
    return target === state?.activeTabId ? undefined : target;
  }

  /** A new browser state: the tab to show when the agent moved to another, else undefined. */
  follow(threadId: string, state: BrowserState): string | undefined {
    if (this.#threadId !== threadId) return undefined;
    const target = agentTab(state);
    return target && target !== state.activeTabId ? target : undefined;
  }

  /**
   * The thread's status as it reads now; true when watch mode ended because the agents aren't
   * working. Any stopped reading ends it, so a repeated one or a reconnect's snapshot does too.
   */
  status(threadId: string, status: string | undefined): boolean {
    if (this.#threadId !== threadId || !finished(status)) return false;
    this.stop();
    return true;
  }

  stop(): void {
    this.#threadId = undefined;
  }
}
