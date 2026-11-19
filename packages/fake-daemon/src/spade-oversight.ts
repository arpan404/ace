import type { FakeSpadeAnswer } from "./spade.ts";

/*
 * The oversight part of the fake Spade API (ADR 0135, spade/docs/oversight.md): the service's
 * oversight, each bot's spend and review switch, and its activity log, in Spade's JSON. Spend is
 * whatever the test sets; the fake never counts it. Spade has no spending limits (ADR 0166).
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
}

export const noSpending = (): FakeSpadeSpending => ({
  today_micros: 0,
  month_micros: 0,
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
    today_micros: 0,
    month_micros: 0,
    review_default: false,
    review_model: null as string | null,
  };
  /** Each bot's activity entries, newest first, in Spade's JSON. */
  readonly activity = new Map<string, Json[]>();
  /**
   * How many event numbers one request reads back from where it starts, as Spade bounds a
   * long history; unbounded when unset.
   */
  readsPerRequest: number | undefined;

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
    const top =
      before === null
        ? Math.max(0, ...(this.activity.get(agent) ?? []).map((e) => Number(e.seq))) + 1
        : Number(before);
    const low = this.readsPerRequest === undefined ? -Infinity : top - this.readsPerRequest;
    const read = matching.filter((entry) => Number(entry.seq) >= low);
    const page = read.slice(0, limit);
    const olderLeft = matching.some((entry) => Number(entry.seq) < low);
    const nextBefore =
      read.length > limit ? Number(page.at(-1)?.seq) : olderLeft ? Math.max(low, 1) : null;
    return reply({ entries: page, more: nextBefore !== null, next_before: nextBefore });
  }
}
