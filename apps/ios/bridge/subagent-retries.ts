import type { Agent } from "@ace/protocol";

/*
 * Which failed or stopped subagents the person already asked a parent to retry, for the life of
 * the bridge (beyond any one visit to the thread), so a reopened lane says "Asked" instead of
 * offering the button again. An ask is remembered for one ending: the agent's own state and end,
 * and its latest run. Its parent running it again changes them, and it can be asked about once more.
 * Another agent in the tree ending changes none of them.
 */

export type RetryAsk = "queued" | "sent";

/** What identifies an agent's ending: its own status and end, and its latest run's end. */
export interface Ending {
  agent: Pick<Agent, "id" | "status" | "endedAt">;
  /** Its latest run (turn): a new run that ends again is a new ending. */
  run?: { id: string; endedAt?: number | undefined } | undefined;
}

/** The ending a retry is about: changes only when the agent's own status, end or run does. */
export function retryEnding({ agent, run }: Ending): string {
  return [agent.status.state, agent.endedAt ?? "", run?.id ?? "", run?.endedAt ?? ""].join(":");
}

/** Remembered asks; the oldest are forgotten past `limit`. */
export class SubagentRetries {
  readonly #asks = new Map<string, { ending: string; ask: RetryAsk | "pending" }>();
  readonly #limit: number;
  constructor(limit = 512) {
    this.#limit = limit;
  }
  /** "queued", "sent" or "pending" (saved, not yet admitted) for this ending; else undefined. */
  asked(threadId: string, ending: Ending) {
    const kept = this.#asks.get(key(threadId, ending.agent.id));
    return kept && kept.ending === retryEnding(ending) ? kept.ask : undefined;
  }
  /** An ask is on its way for this ending: a second press sends nothing. */
  begin(threadId: string, ending: Ending): void {
    const id = key(threadId, ending.agent.id);
    this.#asks.delete(id);
    this.#asks.set(id, { ending: retryEnding(ending), ask: "pending" });
    for (const oldest of this.#asks.keys()) {
      if (this.#asks.size <= this.#limit) break;
      this.#asks.delete(oldest);
    }
  }
  /** The device saved it: it waits for the parent's turn, or starts one. */
  settle(threadId: string, agentId: string, ask: RetryAsk): void {
    const kept = this.#asks.get(key(threadId, agentId));
    if (kept) kept.ask = ask;
  }
  /** It wasn't saved: the button comes back. */
  forget(threadId: string, agentId: string): void {
    this.#asks.delete(key(threadId, agentId));
  }
}

const key = (threadId: string, agentId: string) => `${threadId}\u0000${agentId}`;

/** An agent's ending as the store has it: the agent and the latest of its runs. */
export function endingOf(
  store: {
    agent(id: string): Ending["agent"] | undefined;
    runIds?(): readonly string[];
    run(
      id: string,
    ): { id: string; agentId: string; startedAt: number; endedAt?: number | undefined } | undefined;
  },
  agentId: string,
): Ending | undefined {
  const agent = store.agent(agentId);
  if (!agent) return undefined;
  let run: Ending["run"];
  let latest = -Infinity;
  for (const id of store.runIds?.() ?? []) {
    const candidate = store.run(id);
    if (candidate?.agentId === agentId && candidate.startedAt >= latest) {
      latest = candidate.startedAt;
      run = { id: candidate.id, endedAt: candidate.endedAt };
    }
  }
  return { agent, run };
}
