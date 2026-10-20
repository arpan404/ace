import type { AgentStatus } from "@ace/protocol";
import type { Store } from "./store.ts";

/** The browser side of an agent finishing: its temporary tabs close, its tab cursor goes. */
export interface BrowserTurnPort {
  agentFinished(threadId: string, agentId: string): Promise<void>;
}

/** States after which an agent runs nothing until it is asked again: its turn is over. */
const settled = new Set<AgentStatus["state"]>(["idle", "interrupted", "failed"]);

/**
 * Tells the browsers when an agent's turn ends (#943). Only a settled agent counts: one that
 * waits on subagents, background work or a person reports `blocked`, never `idle`, so its tabs
 * stay while any part of its work still runs.
 */
export function watchBrowserTurns(
  store: Pick<Store, "subscribe">,
  ports: readonly BrowserTurnPort[],
  onError: (error: unknown) => void,
): () => void {
  return store.subscribe((events) => {
    for (const event of events) {
      const payload = event.payload;
      if (payload.type !== "agent.status" || !settled.has(payload.status.state)) continue;
      for (const port of ports)
        void port.agentFinished(event.threadId, payload.agentId).catch(onError);
    }
  });
}
