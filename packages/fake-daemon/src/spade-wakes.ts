import type { FakeSpadeAnswer } from "./spade.ts";

type Json = Record<string, unknown>;

const reply = (body: unknown, status = 200): FakeSpadeAnswer => ({
  status,
  body: JSON.stringify(body),
});
const problem = (status: number, error: string): FakeSpadeAnswer => reply({ error }, status);

/** What the wakes and digests need of the fake's agents and conversations. */
export interface FakeSpadeWakeDeps {
  /** The conversation of agent `id`; undefined for no such agent. */
  conversationOf(id: string): string | undefined;
  /** A conversation's stored event bodies, oldest first. */
  events(conversation: string): readonly Json[];
  store(conversation: string, event: Json): void;
}

/**
 * A bot's wakes (ADR 0160) and digests (ADR 0165) as Spade serves them: the open wakes are a
 * fold of the conversation's events, Wake now stores `wake_fired {cause: person}` and Cancel
 * `wake_cancelled {by: person}`, each only while the wake is open (`409` after). Digests are
 * what tests and worlds add, listed newest first.
 */
export class FakeSpadeWakes {
  /** Every digest, in Spade's JSON (`{id, agent, made_ms, text, digest}`). */
  readonly digests: Json[] = [];
  private readonly deps: FakeSpadeWakeDeps;

  constructor(deps: FakeSpadeWakeDeps) {
    this.deps = deps;
  }

  /** The open wakes of `conversation`, as `wake_set` bodies, in the order they were set. */
  open(conversation: string): Json[] {
    const open = new Map<string, Json>();
    for (const event of this.deps.events(conversation)) {
      const wake = String(event.wake ?? "");
      if (event.type === "wake_set") open.set(wake, event);
      if (event.type === "wake_fired" || event.type === "wake_cancelled") open.delete(wake);
    }
    return [...open.values()];
  }

  /** `/v1/agents/{id}/wakes[/{wake}[/wake]]`. */
  route(method: string, agent: string, wake: string | undefined, action: string | undefined) {
    const conversation = this.deps.conversationOf(agent);
    if (!conversation) return problem(404, "no such agent");
    const open = this.open(conversation);
    if (method === "GET" && wake === undefined)
      return reply({
        wakes: open.map((set) => ({
          id: set.wake,
          purpose: (set.purpose as Json | undefined)?.kind ?? "wait",
          due_at: set.due_ms ?? null,
          condition: set.condition ?? null,
          reason: set.reason ?? "",
        })),
      });
    if (!wake) return problem(404, "Not found.");
    if (!open.some((set) => set.wake === wake)) return problem(409, "that wake is not open");
    if (method === "POST" && action === "wake") {
      this.deps.store(conversation, { type: "wake_fired", wake, cause: "person" });
      return { status: 202 };
    }
    if (method === "DELETE" && action === undefined) {
      this.deps.store(conversation, { type: "wake_cancelled", wake, by: "person" });
      return { status: 204 };
    }
    return problem(404, "Not found.");
  }

  /** `GET /v1/digests?agent=`: newest first. */
  list(query: URLSearchParams): FakeSpadeAnswer {
    const agent = query.get("agent");
    return reply({
      digests: this.digests
        .filter((digest) => !agent || digest.agent === agent)
        .toSorted((a, b) => Number(b.made_ms) - Number(a.made_ms)),
    });
  }
}
