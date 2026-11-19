import type { FakeSpadeAnswer } from "./spade.ts";
import type { FakeSpadeAgent } from "./spade-agent.ts";

/*
 * A bot's work in Spade's own JSON (ADR 0159, 0161; spade/docs/autonomy.md, workers.md): its
 * goal, plan, the check's verdict and derived progress at `GET /v1/agents/{id}/task`, the
 * person's changes at `PUT|DELETE /v1/agents/{id}/task/goal`, and its tree of workers at
 * `GET /v1/agents/{id}/tree`, folded from each bot's `parent`. Tests and the fake app stage a
 * task with `setTask` and ace children with `addAce`.
 */

type Json = Record<string, unknown>;

const reply = (body: unknown, status = 200): FakeSpadeAnswer => ({
  status,
  body: JSON.stringify(body),
});
const problem = (status: number, error: string) => reply({ error }, status);

export interface FakeSpadeTask {
  goal: Json;
  items: Json[];
  verdict: Json | null;
  checkpoint: Json | null;
  progress: { state: string; items_total: number; items_closed: number; items_verified: number };
}

export class FakeSpadeWork {
  /** Each bot's latest task, by agent id; absent for a bot that never had a goal. */
  readonly tasks = new Map<string, FakeSpadeTask>();
  /** Each bot's ace children (`{id, name, state}`), by agent id. */
  readonly ace = new Map<string, Json[]>();
  private readonly agents: () => FakeSpadeAgent[];

  constructor(agents: () => FakeSpadeAgent[]) {
    this.agents = agents;
  }

  /** Stages a bot's task; its progress is derived from the items unless given. */
  setTask(
    agent: string,
    task: Omit<FakeSpadeTask, "progress" | "checkpoint"> & {
      progress?: Partial<FakeSpadeTask["progress"]>;
    },
  ): void {
    const items = task.items;
    this.tasks.set(agent, {
      ...task,
      checkpoint: null,
      progress: {
        state: "working",
        items_total: items.length,
        items_closed: items.filter((item) => item.status === "done").length,
        items_verified: items.filter((item) => item.verified === true).length,
        ...task.progress,
      },
    });
  }

  /** An ace coding agent the bot started through `delegate` (ADR 0161), by thread id. */
  addAce(agent: string, child: { id: string; name: string; state: string }): void {
    this.ace.set(agent, [...(this.ace.get(agent) ?? []), child]);
  }

  /** What the roster adds for an agent: `task_progress`, `parent` and unsettled `workers`. */
  rosterFields(agent: FakeSpadeAgent): Json {
    const task = this.tasks.get(agent.id);
    const workers = this.children(agent.id).filter((child) => child.state !== "idle").length;
    return {
      task_progress: task?.progress ?? {
        state: "none",
        items_total: 0,
        items_closed: 0,
        items_verified: 0,
      },
      parent: agent.parent ?? null,
      workers,
    };
  }

  /** `/v1/agents/{id}/task` and `/task/goal`; undefined for any other path. */
  route(method: string, agent: FakeSpadeAgent, sub: string, subId: string | undefined, body: Json) {
    if (sub === "tree" && method === "GET") return reply({ tree: this.node(agent, 0) });
    if (sub !== "task") return undefined;
    const task = this.tasks.get(agent.id);
    if (!subId && method === "GET") return reply({ task: task ?? null });
    if (subId !== "goal") return problem(404, "Not found.");
    if (method === "PUT") {
      const title = typeof body.title === "string" ? body.title.trim() : "";
      const criteria = Array.isArray(body.criteria)
        ? body.criteria.filter((each): each is string => typeof each === "string" && !!each.trim())
        : [];
      if (!title) return problem(400, "A goal needs a title.");
      if (!criteria.length) return problem(400, "A goal needs at least one criterion.");
      const open = task && !task.goal.closed ? task : undefined;
      const next: FakeSpadeTask = {
        goal: {
          id: open ? open.goal.id : `g${(task ? Number(String(task.goal.id).slice(1)) : 0) + 1}`,
          title,
          text: typeof body.text === "string" ? body.text : (open?.goal.text ?? title),
          criteria: criteria.map((text, index) => ({ id: String(index + 1), text })),
          by: "person",
        },
        items: open?.items ?? [],
        // A changed goal is checked again on the next claim.
        verdict: null,
        checkpoint: open?.checkpoint ?? null,
        progress: {
          ...(open?.progress ?? {
            items_total: 0,
            items_closed: 0,
            items_verified: 0,
          }),
          state: "working",
        },
      };
      this.tasks.set(agent.id, next);
      return reply({ task: next });
    }
    if (method === "DELETE") {
      if (!task || task.goal.closed) return problem(409, "No goal is open.");
      this.tasks.set(agent.id, {
        ...task,
        goal: { ...task.goal, closed: "cleared" },
        progress: { ...task.progress, state: "none" },
      });
      return { status: 204 };
    }
    return problem(405, "Not allowed.");
  }

  /**
   * `DELETE /v1/agents/{id}` for a bot with workers: `409 {error, workers}` without `?workers`,
   * else each worker becomes a top-level bot, stopped or still going. Undefined: none to ask.
   */
  deleting(agent: FakeSpadeAgent, query: URLSearchParams): FakeSpadeAnswer | undefined {
    const workers = this.agents().filter((each) => each.parent?.id === agent.id);
    if (!workers.length) return undefined;
    const choice = query.get("workers");
    if (choice === null)
      return reply({ error: `${agent.name} has workers`, workers: workers.length }, 409);
    if (choice !== "stop" && choice !== "keep") return problem(400, "workers is stop or keep");
    for (const worker of workers) {
      worker.parent = null;
      if (choice === "stop") {
        worker.state = "idle";
        worker.status = null;
      }
    }
    this.ace.delete(agent.id);
    return undefined;
  }

  private children(id: string) {
    return this.agents().filter((each) => each.parent?.id === id);
  }

  /** A bot's node as `GET /tree` answers it, with its workers under it. */
  private node(agent: FakeSpadeAgent, depth: number): Json {
    const bots =
      depth < 16 ? this.children(agent.id).map((child) => this.node(child, depth + 1)) : [];
    const ace = (this.ace.get(agent.id) ?? []).map((child) => ({
      kind: "ace",
      id: child.id,
      name: child.name,
      state: child.state,
      needs_you: child.state === "needs_you" || child.state === "limited",
      job: `job-${String(child.id)}`,
      cost_micros: null,
      children: [],
    }));
    const children = [...bots, ...ace];
    const own = agent.spending?.month_micros ?? 0;
    const subtree = bots.reduce<number>(
      (sum, child) =>
        sum + (typeof child.subtree_cost_micros === "number" ? child.subtree_cost_micros : 0),
      own,
    );
    const rolled = (state: string) =>
      children.some((child) => child.state === state || (state === "waiting" && child.needs_you));
    const state =
      agent.state === "waiting" || rolled("waiting")
        ? "waiting"
        : agent.state === "working" || rolled("working")
          ? "working"
          : "idle";
    return {
      kind: "bot",
      id: agent.id,
      name: agent.name,
      conversation: agent.conversation,
      state,
      own_state: agent.state,
      status: agent.status,
      needs_you: state === "waiting",
      waiting_for:
        state === "waiting" ? (agent.state === "waiting" ? agent.waiting_for : "worker") : null,
      progress: this.rosterFields(agent).task_progress,
      cost_micros: own,
      subtree_cost_micros: subtree,
      budget_micros: null,
      parked: null,
      queued: false,
      children,
    };
  }
}
