import type { FakeSpadeAnswer } from "./spade.ts";

type Json = Record<string, unknown>;

const reply = (body: unknown, status = 200): FakeSpadeAnswer => ({
  status,
  body: JSON.stringify(body),
});

/**
 * How Spade reaches the person (ADR 0195) as Spade serves it: `/v1/reach` with its settings,
 * why notices wait now and how many, an object's fields replaced one by one, and each bot's own
 * switch at `/v1/agents/{id}/reach`. Nothing is checked beyond its shape.
 */
export class FakeSpadeReach {
  settings: Json = {
    notify: true,
    dnd: false,
    quiet: null,
    budget: { per_hour: 6, per_day: 30 },
    brief: { on: false, at: 480, bots: null, polish: false },
    spend: { on: true, factor: 5, floor_micros: 1_000_000 },
  };
  /** How many notices wait for the next digest or brief. */
  held = 0;
  /** Each bot's own choices; null follows Spade's setting. */
  readonly agents = new Map<
    string,
    { notify: boolean | null; approvals: "notify" | "wait" | null }
  >();

  route(method: string, body: Json): FakeSpadeAnswer {
    if (method === "PUT")
      for (const [key, value] of Object.entries(body)) {
        const into = this.settings[key];
        this.settings[key] =
          value && typeof value === "object" && into && typeof into === "object"
            ? { ...(into as Json), ...(value as Json) }
            : value;
      }
    return reply({
      settings: this.settings,
      quiet: this.settings.dnd === true ? "dnd" : null,
      held: this.held,
    });
  }

  agentRoute(method: string, agent: string, body: Json): FakeSpadeAnswer {
    const own = this.agents.get(agent) ?? { notify: null, approvals: null };
    if (method === "PUT") {
      // As Spade: only the fields sent change; null follows Spade's setting again.
      if ("notify" in body) own.notify = typeof body.notify === "boolean" ? body.notify : null;
      if ("approvals" in body)
        own.approvals =
          body.approvals === "notify" || body.approvals === "wait" ? body.approvals : null;
      this.agents.set(agent, own);
    }
    return reply(own);
  }
}
