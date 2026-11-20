import type { FakeSpadeAgent } from "./spade-agent.ts";
import type { FakeSpadeAnswer } from "./spade.ts";

type Json = Record<string, unknown>;

const reply = (body: unknown, status = 200): FakeSpadeAnswer => ({
  status,
  body: JSON.stringify(body),
});
const problem = (status: number, error: string): FakeSpadeAnswer => reply({ error }, status);

/** What a test or a world sets of a bot's running row beyond its roster state. */
export interface FakeRunningFacts {
  uses?: {
    answering?: boolean;
    jobs?: number;
    workers?: number;
    services?: number;
    agents?: boolean;
  };
  spend?: Json;
  network?: Json;
  next_wake?: { at_ms: number; what: string } | null;
  workers?: { id: string; name: string; state: string; doing: string }[];
  failure?: string | null;
}

/** What the running view needs of the fake's agents. */
export interface FakeSpadeRunningDeps {
  agents(): readonly FakeSpadeAgent[];
  /** Sets an agent's state and words, on its row and its live stream. */
  status(agent: FakeSpadeAgent, state: FakeSpadeAgent["state"], status: string | null): void;
  now(): number;
}

const rank = { needs_you: 0, working: 1, failed: 2, sleeping: 3, paused: 4, idle: 5 } as const;
type Reads = keyof typeof rank;

/**
 * The task manager (ADR 0200 §6.3) as Spade serves it: `GET /v1/running` folds each top-level
 * bot's roster state and the facts a test set, in Spade's order; `POST /v1/agents/{id}/pause`,
 * `resume` and `stop` change the bot and answer with every row. Pause holds what it was waiting
 * on the person for; the person's every action is recorded.
 */
export class FakeSpadeRunning {
  /** Each bot's facts beyond its state, by agent id. */
  readonly facts = new Map<string, FakeRunningFacts>();
  /** When each paused bot was paused, by agent id. */
  readonly paused = new Map<string, number>();
  /** Every action the person took, in order. */
  readonly actions: { agent: string; action: string }[] = [];
  private readonly deps: FakeSpadeRunningDeps;

  constructor(deps: FakeSpadeRunningDeps) {
    this.deps = deps;
  }

  /** Pauses `agent` as Spade does: stopped, then held. */
  pause(agent: FakeSpadeAgent): void {
    this.paused.set(agent.id, this.deps.now());
    if (agent.state !== "waiting") this.deps.status(agent, "paused", "Paused");
  }

  rows(): Json[] {
    const top = this.deps.agents().filter((agent) => !agent.parent);
    return top
      .map((agent) => this.row(agent))
      .toSorted(
        (a, b) =>
          rank[a.reads as Reads] - rank[b.reads as Reads] ||
          String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" }),
      );
  }

  private row(agent: FakeSpadeAgent): Json {
    const facts = this.facts.get(agent.id) ?? {};
    const pausedAt = this.paused.get(agent.id);
    const failure = facts.failure ?? undefined;
    const sleeping = agent.state === "working" && agent.status?.startsWith("Sleeping");
    const reads: Reads =
      agent.state === "waiting"
        ? "needs_you"
        : agent.state === "paused" || pausedAt !== undefined
          ? "paused"
          : sleeping
            ? "sleeping"
            : agent.state === "working"
              ? "working"
              : failure
                ? "failed"
                : "idle";
    const doing =
      reads === "needs_you"
        ? agent.waiting_for === "question"
          ? "Waiting on you: a question"
          : "Waiting on you: an approval"
        : reads === "paused"
          ? "Paused"
          : reads === "failed"
            ? `Failed: ${failure}`
            : reads === "idle"
              ? "Idle"
              : (agent.status ?? "Working");
    const uses = {
      answering: reads === "working" || reads === "needs_you",
      jobs: 0,
      workers: facts.workers?.length ?? 0,
      services: 0,
      agents: false,
      ...facts.uses,
    };
    const runs =
      reads === "working" ||
      reads === "needs_you" ||
      reads === "sleeping" ||
      uses.answering ||
      uses.jobs > 0 ||
      uses.workers > 0 ||
      uses.services > 0 ||
      uses.agents;
    return {
      id: agent.id,
      name: agent.name,
      kind: agent.kind,
      conversation: agent.conversation,
      avatar: agent.avatar,
      state: reads === "needs_you" ? "waiting" : reads === "failed" ? "idle" : reads,
      reads,
      doing,
      ...(reads === "failed" ? { failure } : {}),
      ...(pausedAt === undefined ? {} : { paused_at_ms: pausedAt }),
      ...(agent.archived ? { archived: true } : {}),
      uses,
      spend: {
        today_micros: 0,
        month_micros: 0,
        last_hour_micros: 0,
        alert_line_micros: 1_000_000,
        unusual: false,
        ...facts.spend,
      },
      network: { sent_bytes: 0, received_bytes: 0, hosts: [], refused: 0, ...facts.network },
      ...(facts.next_wake ? { next_wake: facts.next_wake } : {}),
      workers: facts.workers ?? [],
      // A bot linked to a package folder on this machine (`ace bot dev`), as Spade marks it.
      ...(isLocalPackage(agent.package) ? { development: true } : {}),
      actions: [
        ...(runs ? ["stop"] : []),
        pausedAt === undefined ? "pause" : "resume",
        ...(agent.archived ? ["unarchive"] : []),
      ],
    };
  }

  /** `GET /v1/running`, and `POST /v1/agents/{id}/{pause,resume,stop,unarchive}`. */
  route(method: string, agentId: string | undefined, action: string | undefined): FakeSpadeAnswer {
    if (agentId === undefined)
      return method === "GET" ? reply({ bots: this.rows() }) : problem(405, "Not allowed.");
    if (method !== "POST") return problem(405, "Not allowed.");
    const agent = this.deps.agents().find((candidate) => candidate.id === agentId);
    if (!agent) return problem(404, "no such agent");
    this.actions.push({ agent: agentId, action: action ?? "" });
    let changed = false;
    if (action === "pause" && !this.paused.has(agentId)) {
      this.pause(agent);
      changed = true;
    } else if (action === "resume" && this.paused.delete(agentId)) {
      if (agent.state === "paused") this.deps.status(agent, "idle", null);
      changed = true;
    } else if (action === "unarchive" && agent.archived) {
      // As Spade: the mark comes off; its routines are Spade's to turn back on.
      agent.archived = false;
      changed = true;
    } else if (action === "stop") {
      changed = agent.state === "working" || (this.facts.get(agentId)?.workers?.length ?? 0) > 0;
      const facts = this.facts.get(agentId);
      if (facts) this.facts.set(agentId, { ...facts, workers: [], uses: {} });
      if (agent.state === "working") this.deps.status(agent, "idle", null);
    }
    return reply({ changed, bots: this.rows() });
  }
}

function isLocalPackage(link: unknown): boolean {
  return typeof link === "object" && link !== null && "source" in link && link.source === "local";
}
