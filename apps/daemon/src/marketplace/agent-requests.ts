import type { MarketOperation, MarketResult } from "@ace/protocol/marketplace";
import { agentRoute, type AgentFacts } from "./agent-gate.ts";
import type { MarketPersonRequests } from "./person-requests.ts";

/*
 * A market request an agent makes, from `market_read`/`market_publish` or from `ace market` in
 * its shell (ADR 0178 §12.5): the gate decides, then it runs as the person would, or becomes the
 * person's request in the asking thread. The shell around `agent-gate.ts`.
 */

export interface AgentMarketDeps {
  /** Runs an operation through the marketplace with this machine's grant. */
  run(operation: MarketOperation): Promise<MarketResult>;
  requests(): Pick<MarketPersonRequests, "open"> | undefined;
  /** `market.askBeforeAgentPublish`; on when it can't be read (fails closed). */
  askBeforePublish(): Promise<boolean>;
  /** The product name of the agent in `threadId`: "Codex". */
  agentName(threadId: string): string;
}

export async function agentMarketRequest(
  deps: AgentMarketDeps,
  threadId: string,
  operation: MarketOperation,
): Promise<MarketResult> {
  const facts: { -readonly [K in keyof AgentFacts]: AgentFacts[K] } = {
    agent: deps.agentName(threadId),
    askBeforePublish: await deps.askBeforePublish(),
  };
  let install: Parameters<MarketPersonRequests["open"]>[3];
  if (operation.op === "install") {
    const page = await deps.run({ op: "readReview", id: operation.id, offset: 0 });
    if (page.op === "reviewPage") {
      install = { review: page.review };
      facts.installing = `${page.review.type}/${page.review.name} ${page.review.version}`;
    }
  }
  const route = agentRoute(operation, facts);
  if (route.kind === "run") return deps.run(operation);
  const request = deps.requests()?.open(threadId, route.ask, operation, install);
  return request
    ? { op: "error", code: "person_only", message: route.ask.refusal, request }
    : {
        op: "error",
        code: "person_only",
        message: `${route.ask.refusal.split(".")[0]}. ace has no thread ${threadId} here to ask you in.`,
      };
}
