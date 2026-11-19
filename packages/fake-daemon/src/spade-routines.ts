import type { FakeSpadeAnswer } from "./spade.ts";

/*
 * The routines part of the fake Spade API (ADR 0129, spade/docs/routines.md): each bot's
 * routines and heartbeat, in Spade's JSON. It reads schedules only far enough to answer in
 * words; firing is the real Spade's job, which tests stage with `FakeSpadeApi.store`.
 */

type Json = Record<string, unknown>;

export interface FakeSpadeRoutine {
  id: string;
  agent: string;
  name: string;
  instruction: string;
  trigger: Json;
  words: string;
  time_zone: string;
  paused: boolean;
  next_run: number | null;
  last_run: Json | null;
  webhook: { path: string; secret: string } | null;
  created_by: "person" | "agent";
  created_at: number;
  updated_at: number;
}

const reply = (body: unknown, status = 200): FakeSpadeAnswer => ({
  status,
  body: JSON.stringify(body),
});
const problem = (status: number, error: string) => reply({ error }, status);

/** Spade's words for the few triggers tests use. */
function words(trigger: Json): string | undefined {
  if (trigger.kind === "webhook") return "When its webhook is called";
  if (trigger.kind === "event")
    return {
      thread_done: "When an agent thread finishes",
      thread_failed: "When an agent thread fails",
      thread_needs_you: "When an agent thread needs you",
    }[String(trigger.event)];
  if (trigger.kind !== "schedule") return undefined;
  const match = /^(daily|weekdays) at (\d{1,2}:\d{2})$/.exec(String(trigger.schedule).trim());
  if (!match) return undefined;
  return `${match[1] === "daily" ? "Every day" : "Weekdays"} at ${match[2]}`;
}

export class FakeSpadeRoutines {
  routines: FakeSpadeRoutine[] = [];
  heartbeats = new Map<string, Json>();
  private sequence = 0;
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  /** `/v1/agents/{agent}/routines` and `/v1/agents/{agent}/heartbeat`. */
  agentRoute(method: string, agent: string, sub: string, body: Json): FakeSpadeAnswer {
    if (sub === "heartbeat") {
      const current = this.heartbeats.get(agent) ?? {
        enabled: false,
        every_minutes: 30,
        checklist: "",
        quiet: null,
        time_zone: "UTC",
        next_run: null,
        last_run: null,
      };
      if (method === "GET") return reply({ heartbeat: current });
      const next = { ...current, ...body };
      if (next.enabled === true && !String(next.checklist ?? "").trim())
        return problem(400, "A heartbeat needs a checklist to go through.");
      next.next_run =
        next.enabled === true ? this.now() + Number(next.every_minutes) * 60_000 : null;
      this.heartbeats.set(agent, next);
      return reply({ heartbeat: next });
    }
    if (method === "GET")
      return reply({ routines: this.routines.filter((routine) => routine.agent === agent) });
    const trigger = (body.trigger ?? {}) as Json;
    const said = words(trigger);
    if (!said)
      return problem(400, `Could not read the schedule ${JSON.stringify(trigger.schedule)}.`);
    const id = `rt_${++this.sequence}`;
    const routine: FakeSpadeRoutine = {
      id,
      agent,
      name: String(body.name ?? ""),
      instruction: String(body.instruction ?? ""),
      trigger,
      words: said,
      time_zone: String(body.time_zone ?? "UTC"),
      paused: body.paused === true,
      next_run: trigger.kind === "schedule" ? this.now() + 3_600_000 : null,
      last_run: null,
      webhook:
        trigger.kind === "webhook"
          ? { path: `/v1/routines/${id}/run`, secret: "f".repeat(64) }
          : null,
      created_by: "person",
      created_at: this.now(),
      updated_at: this.now(),
    };
    this.routines.push(routine);
    return reply({ routine }, 201);
  }

  /** `/v1/routines/{id}` and `/v1/routines/{id}/run`. */
  route(method: string, id: string, sub: string | undefined, body: Json): FakeSpadeAnswer {
    const routine = this.routines.find((candidate) => candidate.id === id);
    if (!routine) return problem(404, "no such routine");
    if (sub === "run" && method === "POST") {
      routine.last_run = {
        id: `run_${++this.sequence}`,
        at: this.now(),
        cause: "manual",
        result: "running",
        detail: "run now",
      };
      return reply({ run: routine.last_run }, 202);
    }
    if (method === "GET") return reply({ routine });
    if (method === "DELETE") {
      this.routines = this.routines.filter((candidate) => candidate !== routine);
      return { status: 204 };
    }
    if (method === "PATCH") {
      if (body.trigger) {
        const said = words(body.trigger as Json);
        if (!said) return problem(400, "Could not read the schedule.");
        routine.trigger = body.trigger as Json;
        routine.words = said;
      }
      for (const key of ["name", "instruction", "time_zone"] as const)
        if (typeof body[key] === "string") routine[key] = body[key];
      if (typeof body.paused === "boolean") {
        routine.paused = body.paused;
        routine.next_run = body.paused ? null : this.now() + 3_600_000;
      }
      routine.updated_at = this.now();
      return reply({ routine });
    }
    return problem(405, "Not allowed.");
  }
}
