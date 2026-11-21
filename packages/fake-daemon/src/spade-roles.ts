import type { FakeSpadeAnswer } from "./spade.ts";

/*
 * Models for other work (ADR 0162) for the fake API, in Spade's JSON: the person's choices for
 * every bot and on each bot, the model each role resolves to and where it came from, and what
 * each role spent this month.
 */

type Json = Record<string, unknown>;
type Roles = Record<string, string | null>;

export const fakeRoleNames = ["helper", "verify", "review", "compact", "title"] as const;

const answer = (body: unknown, status = 200): FakeSpadeAnswer => ({
  status,
  body: JSON.stringify(body),
});
const problem = (status: number, error: string) => answer({ error }, status);
const empty = (): Roles => Object.fromEntries(fakeRoleNames.map((role) => [role, null]));

export class FakeSpadeRoles {
  global: Roles = empty();
  /** Each role's route in order (ADR 0205 §2), `main` included: what a bot's model falls back to. */
  globalRoutes: Record<string, string[]> = {};
  globalEscalate: boolean | null = null;
  /** What each bot sets for itself, by agent id. */
  readonly bots = new Map<string, { roles: Roles; escalate: boolean | null }>();
  /** This month's spend by role, in micros, by agent id. */
  readonly spend = new Map<string, Record<string, number>>();
  /** What a role falls back to with nothing set: the fast model, or for `verify` this. */
  strongest: string | null = null;

  private apply(
    roles: Roles,
    body: Json,
    routes?: Record<string, string[]>,
  ): FakeSpadeAnswer | undefined {
    const change = body.roles;
    if (typeof change !== "object" || change === null) return undefined;
    for (const [role, model] of Object.entries(change as Json)) {
      const main = role === "main" && routes !== undefined;
      if (!main && !(fakeRoleNames as readonly string[]).includes(role))
        return problem(400, `there is no role named ${role}`);
      const list = (Array.isArray(model) ? model : [model]).filter(
        (each): each is string => typeof each === "string" && each.length > 0,
      );
      if (list.length > 4) return problem(400, "a route holds at most 4 models");
      if (list.some((each) => each.startsWith("cli:")))
        return problem(400, "a route never holds a subscription");
      if (!main) roles[role] = list[0] ?? null;
      if (routes) {
        if (list.length) routes[role] = list;
        else delete routes[role];
      }
    }
    return undefined;
  }

  globalView() {
    const routes = Object.fromEntries(
      ["main", ...fakeRoleNames].map((role) => [role, this.globalRoutes[role] ?? []]),
    );
    return { roles: { ...this.global }, routes, escalate: this.globalEscalate };
  }

  globalRoute(method: string, body: Json) {
    if (method === "PUT") {
      const refused = this.apply(this.global, body, this.globalRoutes);
      if (refused) return refused;
      if ("escalate" in body)
        this.globalEscalate = typeof body.escalate === "boolean" ? body.escalate : null;
    } else if (method !== "GET") return problem(405, "Not allowed.");
    return answer(this.globalView());
  }

  agentView(agent: string, own: string, fast: string | null) {
    const bot = this.bots.get(agent) ?? { roles: empty(), escalate: null };
    const month = this.spend.get(agent) ?? {};
    const roles = [
      { role: "main", model: own, source: "own" },
      ...fakeRoleNames.map((role) => {
        const fallback = role === "verify" ? (this.strongest ?? fast) : fast;
        const [model, source] = bot.roles[role]
          ? [bot.roles[role], "bot"]
          : this.global[role]
            ? [this.global[role], "global"]
            : fallback && fallback !== own
              ? [fallback, "default"]
              : [own, "own"];
        return { role, model, source };
      }),
    ];
    return {
      roles,
      overrides: { roles: { ...bot.roles }, allowed: null, escalate: bot.escalate },
      escalate: bot.escalate ?? this.globalEscalate ?? false,
      spend: { today: {}, month },
    };
  }

  agentRoute(method: string, agent: string, own: string, fast: string | null, body: Json) {
    if (method === "PUT") {
      const bot = this.bots.get(agent) ?? { roles: empty(), escalate: null };
      const refused = this.apply(bot.roles, body);
      if (refused) return refused;
      if ("escalate" in body)
        bot.escalate = typeof body.escalate === "boolean" ? body.escalate : null;
      this.bots.set(agent, bot);
    } else if (method !== "GET") return problem(405, "Not allowed.");
    return answer(this.agentView(agent, own, fast));
  }
}
