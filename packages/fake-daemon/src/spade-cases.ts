import type { FakeSpadeAnswer } from "./spade.ts";

type Json = Record<string, unknown>;

const runs = (n: number) => (n === 1 ? "kept run" : "kept runs");

const reply = (body: unknown, status = 200): FakeSpadeAnswer => ({
  status,
  body: JSON.stringify(body),
});
const problem = (status: number, error: string): FakeSpadeAnswer => reply({ error }, status);

/** What the cases need of the fake's agents and conversations. */
export interface FakeSpadeCaseDeps {
  conversationOf(id: string): string | undefined;
  events(conversation: string): readonly Json[];
  now(): number;
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

/**
 * A bot's kept cases (ADR 0204 §1) as Spade serves them: a finished reply read from the
 * conversation's events into `{given, tool_results, outcome, mark, why}`, with the values the
 * person marked hidden as `•••`. Spade's own redaction of secrets and the person's names is
 * Spade's to test; here a seeded case holds what the test gives it.
 */
export class FakeSpadeCases {
  /** Every kept case, `{summary, case}` as Spade answers, by agent. */
  readonly kept = new Map<string, Json[]>();
  /**
   * Why a kept run doesn't replay the same on the version a replay names (ADR 0204 §2), by case
   * id: a world or a test sets it; every other kept run replays the same.
   */
  readonly differs = new Map<string, string>();
  /** What a model replay would cost, about, for `GET …/cases/replay?model=`. */
  replayCost = {
    model: "openrouter/openai/gpt-6.1-mini",
    model_name: "GPT-6.1 mini",
    micros: 4_000,
  };
  /** Every replay asked for, `{agent, body}`, in order. */
  readonly replays: Json[] = [];
  private readonly deps: FakeSpadeCaseDeps;
  private next = 1;

  constructor(deps: FakeSpadeCaseDeps) {
    this.deps = deps;
  }

  /** The case reply `reply` makes, or why not. */
  private draft(conversation: string, body: Json): Json | string {
    const events = this.deps.events(conversation);
    const at = events.findIndex((e) => e.type === "reply_finished" && e.reply === body.reply);
    if (at < 0) return "no such reply";
    const hide = Array.isArray(body.hide) ? body.hide.map(text).filter((v) => v.length > 1) : [];
    const hidden = (words: string) =>
      hide.reduce((out, value) => out.split(value).join("•••"), words);
    let first = at;
    while (first > 0 && events[first - 1]?.type !== "reply_finished") first -= 1;
    const span = events.slice(first, at + 1);
    return {
      reply: body.reply,
      trigger: { kind: "message" },
      given: {
        messages: span.filter((e) => e.type === "user_message").map((e) => hidden(text(e.text))),
      },
      steps: [],
      tool_results: span
        .filter((e) => e.type === "tool_finished" && e.reply === body.reply)
        .map((e) => ({
          call: e.call_id,
          tool: e.name,
          arguments: {},
          content: hidden(text(e.content)),
        })),
      outcome: { text: hidden(text(events[at]?.text)) },
      ...(body.mark ? { mark: body.mark } : {}),
      ...(body.why ? { why: hidden(text(body.why)) } : {}),
      made_at: this.deps.now(),
    };
  }

  /** Keeps `kase` for `agent` as a test or world seeds one: `{summary, case}`. */
  add(agent: string, kase: Json): Json {
    const id = text(kase.id) || `case_${this.next++}`;
    const given = (kase.given as Json | undefined)?.messages;
    const kept = {
      summary: {
        id,
        reply: kase.reply,
        mark: kase.mark ?? null,
        why: kase.why ?? null,
        trigger: kase.trigger ?? { kind: "message" },
        given: Array.isArray(given) ? text(given[0]) : "",
        outcome: text((kase.outcome as Json | undefined)?.text),
        made_at: kase.made_at ?? this.deps.now(),
      },
      case: { ...kase, id },
    };
    this.kept.set(agent, [kept, ...(this.kept.get(agent) ?? [])]);
    return kept;
  }

  /** `{replay}` for `agent`'s latest 20 kept runs, as Spade judges them. */
  private replay(agent: string, body: Json): Json {
    this.replays.push({ agent, body });
    const kept = (this.kept.get(agent) ?? []).slice(0, 20);
    const model = typeof body.model === "string";
    const cases = kept.map((each) => {
      const summary = each.summary as Json;
      const why = this.differs.get(text(summary.id));
      const judged: Json = {
        id: summary.id,
        given: summary.given || "A kept run",
        passed: why === undefined,
        lines: why === undefined ? [] : [why],
        outside: 0,
      };
      if (summary.mark) judged.mark = summary.mark;
      return judged;
    });
    const passed = cases.filter((each) => each.passed).length;
    const failed = cases.length - passed;
    const [same, worse] = model ? ["the same or better", "worse"] : ["replay the same", "don't"];
    const summary =
      cases.length === 0
        ? "No kept runs to replay."
        : failed === 0
          ? `${cases.length === 1 ? "The" : "All"} ${cases.length} ${runs(cases.length)} ${model ? same : cases.length === 1 ? "replays the same" : same}.`
          : `${passed} of ${cases.length} ${runs(cases.length)} ${same}. ${failed} ${failed === 1 && !model ? "doesn't" : worse}: see why.`;
    return {
      replay: {
        mode: model ? "model" : "wiring",
        ...(model ? { model: this.replayCost.model } : {}),
        cases,
        passed,
        failed,
        outside: 0,
        summary,
      },
    };
  }

  /** `/v1/agents/{id}/cases[/preview | /replay | /{case}]`. */
  route(method: string, agent: string, sub: string | undefined, body: Json): FakeSpadeAnswer {
    const conversation = this.deps.conversationOf(agent);
    if (!conversation) return problem(404, "no such agent");
    const kept = this.kept.get(agent) ?? [];
    if (sub === "replay" && method === "POST") return reply(this.replay(agent, body));
    if (sub === "replay" && method === "GET")
      return reply({
        estimate: {
          model: this.replayCost.model,
          model_name: this.replayCost.model_name,
          cases: Math.min(kept.length, 20),
          cost_micros: this.replayCost.micros * Math.min(kept.length, 20),
          priced: true,
        },
      });
    if (method === "GET" && sub === undefined)
      return reply({ cases: kept.map((each) => each.summary) });
    if (method === "POST" && (sub === undefined || sub === "preview")) {
      const draft = this.draft(conversation, body);
      if (typeof draft === "string") return problem(404, draft);
      if (sub === "preview") return reply({ case: draft });
      const had = kept.find((each) => (each.summary as Json).reply === body.reply);
      if (had) return reply(had);
      return reply(this.add(agent, draft), 201);
    }
    const found = kept.find((each) => (each.summary as Json).id === sub);
    if (!found) return problem(404, "no such case");
    if (method === "GET") return reply(found);
    if (method === "DELETE") {
      this.kept.set(
        agent,
        kept.filter((each) => each !== found),
      );
      return { status: 204 };
    }
    return problem(404, "Not found.");
  }
}
