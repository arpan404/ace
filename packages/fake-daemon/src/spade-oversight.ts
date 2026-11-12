import type { FakeSpadeAnswer } from "./spade.ts";

/*
 * The oversight part of the fake Spade API (ADR 0135, spade/docs/oversight.md): the service's
 * oversight, each bot's caps and review switch, and its activity log, in Spade's JSON. Spend is
 * whatever the test sets; the fake never counts it.
 */

type Json = Record<string, unknown>;

const reply = (body: unknown, status = 200): FakeSpadeAnswer => ({
  status,
  body: JSON.stringify(body),
});
const problem = (status: number, error: string) => reply({ error }, status);

export interface FakeSpadeSpending {
  today_micros: number;
  month_micros: number;
  daily_cap_micros: number | null;
  monthly_cap_micros: number | null;
  capped: "daily" | "monthly" | null;
  resets_at: number | null;
}

export const noSpending = (): FakeSpadeSpending => ({
  today_micros: 0,
  month_micros: 0,
  daily_cap_micros: null,
  monthly_cap_micros: null,
  capped: null,
  resets_at: null,
});

/** What a bot carries for oversight: its spending and its own review switch. */
export interface FakeSpadeOverseen {
  id: string;
  spending?: FakeSpadeSpending;
  review?: boolean | null;
}

export class FakeSpadeOversight {
  oversight = {
    time_zone: "UTC",
    daily_cap_micros: 5_000_000 as number | null,
    today_micros: 0,
    month_micros: 0,
    review_default: false,
    review_model: null as string | null,
  };
  /** Each bot's activity entries, newest first, in Spade's JSON. */
  readonly activity = new Map<string, Json[]>();

  route(method: string, body: Json): FakeSpadeAnswer {
    if (method === "GET") return reply({ oversight: this.oversight });
    if (method !== "PUT") return problem(405, "Not allowed.");
    if (typeof body.time_zone === "string") this.oversight.time_zone = body.time_zone;
    if (typeof body.review_default === "boolean")
      this.oversight.review_default = body.review_default;
    if ("review_model" in body)
      this.oversight.review_model =
        typeof body.review_model === "string" ? body.review_model : null;
    return reply({ oversight: this.oversight });
  }

  agentRoute(method: string, agent: FakeSpadeOverseen, body: Json): FakeSpadeAnswer {
    const spending = (agent.spending ??= noSpending());
    if (method === "PUT") {
      for (const key of ["daily_cap_micros", "monthly_cap_micros"] as const) {
        if (!(key in body)) continue;
        const value = body[key];
        if (typeof value === "number" && value < 0) return problem(400, "A cap can't be negative.");
        spending[key] = typeof value === "number" ? value : null;
      }
      if ("review" in body) agent.review = typeof body.review === "boolean" ? body.review : null;
    } else if (method !== "GET") return problem(405, "Not allowed.");
    return reply({ spending, review: agent.review ?? null });
  }

  activityRoute(agent: string, query: URLSearchParams): FakeSpadeAnswer {
    const kinds = query.get("kind")?.split(",");
    const words = (query.get("q") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const day = query.get("day");
    const before = query.get("before");
    const limit = Number(query.get("limit") ?? 200);
    const matching = (this.activity.get(agent) ?? []).filter((entry) => {
      const text = `${String(entry.name ?? "")} ${String(entry.summary ?? "")}`.toLowerCase();
      return (
        (!kinds || kinds.includes(String(entry.kind))) &&
        words.every((word) => text.includes(word)) &&
        (!day || new Date(Number(entry.at)).toISOString().slice(0, 10) === day) &&
        (before === null || Number(entry.seq) < Number(before))
      );
    });
    return reply({ entries: matching.slice(0, limit), more: matching.length > limit });
  }
}
