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
  readonly agents = new Map<string, boolean | null>();

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
    if (method === "PUT") {
      const notify = body.notify;
      this.agents.set(agent, typeof notify === "boolean" ? notify : null);
    }
    return reply({ notify: this.agents.get(agent) ?? null });
  }
}
