import type { FakeSpadeAnswer } from "./spade.ts";

type Json = Record<string, unknown>;

const reply = (body: unknown, status = 200): FakeSpadeAnswer => ({
  status,
  body: JSON.stringify(body),
});

/**
 * The person's outside A2A agents (ADR 0202 §5) as Spade serves them at `/v1/a2a-agents`: an
 * address added is answered from `cards` (address to the agent Spade would read there), or
 * refused with `refusals`' words, as Spade refuses a card it can't call. An agent is local only
 * when the person added it so (`local: true`).
 */
export class FakeSpadeA2aAgents {
  readonly agents: Json[] = [];
  /** What adding each address reads. */
  readonly cards = new Map<string, Json>();
  readonly refusals = new Map<string, string>();

  route(method: string, id: string | undefined, body: Json): FakeSpadeAnswer {
    if (method === "GET" && !id) return reply({ agents: this.agents });
    if (method === "POST" && !id) {
      const address = typeof body.address === "string" ? body.address : "";
      const refused = this.refusals.get(address);
      if (refused) return reply({ error: refused }, 400);
      const card = this.cards.get(address);
      if (!card) return reply({ error: "Its card couldn't be read." }, 400);
      const agent = { ...card, local: body.local === true };
      this.agents.push(agent);
      return reply({ agent }, 201);
    }
    if (method === "DELETE" && id) {
      const at = this.agents.findIndex((agent) => agent.id === id);
      if (at < 0) return reply({ error: "no such agent" }, 404);
      this.agents.splice(at, 1);
      return { status: 204, body: "" };
    }
    return reply({ error: "not found" }, 404);
  }
}
