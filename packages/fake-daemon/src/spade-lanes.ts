import type { FakeSpadeAnswer } from "./spade.ts";

/*
 * A bot's task lanes (ADR 0217, spade/docs/workers.md "Lanes") in Spade's JSON, for the fake API:
 * `GET /v1/conversations/{main}/tasks` lists them in the task list's order, each lane is a
 * conversation of its own (read, written to and stopped like any), and main holds the lines
 * Spade stores for them: `lane_started`, `reply_moved`, `ask_routed`, the lane's report as a
 * `worker_reported` of kind `lane`, and a lane's request as an `approval_requested` with `lane`.
 *
 * `stageFakeLanes` stores a realistic set (a lane waiting on the person, two running, one moved
 * from main, one failed, one done, one queued) so the app can be built against it.
 */

type Json = Record<string, unknown>;

export type FakeLaneState =
  | "needs_you"
  | "working"
  | "done"
  | "finished"
  | "failed"
  | "stopped"
  | "queued";

export interface FakeLane {
  task: string;
  main: string;
  title: string;
  state: FakeLaneState;
  /** The plan, as `task_plan` left it: each item's words, whether it is done, its evidence. */
  plan: readonly { text: string; done: boolean; evidence?: string }[];
  /** The person's words that asked for it. */
  words: string;
  /** Its goal's title and criteria, when it set one; the title stands in otherwise. */
  goal?: string;
  criteria?: readonly string[];
  startedMs: number;
  endedMs?: number;
  costMicros: number;
  asks: readonly string[];
  moved: boolean;
  model: string;
  /** Its last words once it has ended. */
  report?: string;
  /** How many lanes had ended before it: which ended last when the clock reads the same. */
  endedSeq?: number;
}

/** What the lanes need of the fake API. */
export interface FakeLanesHost {
  store(conversation: string, event: Json, at?: number): void;
  events(conversation: string): Json[];
  now(): number;
}

const reply = (body: unknown, status = 200): FakeSpadeAnswer => ({
  status,
  body: JSON.stringify(body),
});

/** The task list's order (ADR 0217 §7): needs you, running, ended, queued; oldest first. */
const rank: Record<FakeLaneState, number> = {
  needs_you: 0,
  working: 1,
  failed: 2,
  done: 3,
  finished: 3,
  stopped: 3,
  queued: 4,
};

const live = (state: FakeLaneState) =>
  state === "working" || state === "needs_you" || state === "queued";

export class FakeSpadeLanes {
  readonly lanes = new Map<string, FakeLane>();
  readonly #host: FakeLanesHost;
  #ends = 0;

  constructor(host: FakeLanesHost) {
    this.#host = host;
  }

  /** The lane whose conversation is `id`. */
  lane(id: string): FakeLane | undefined {
    return this.lanes.get(id);
  }

  /**
   * Starts a lane of `main`: its conversation with `lane_of` and the person's words, and
   * `lane_started` in main (Spade's moved line too when `moved`).
   */
  start(lane: Omit<FakeLane, "startedMs"> & { startedMs?: number }): FakeLane {
    const { words } = lane;
    const made: FakeLane = { ...lane, startedMs: lane.startedMs ?? this.#host.now() };
    this.lanes.set(made.task, made);
    const host = this.#host;
    host.store(made.task, {
      type: "lane_of",
      parent_conversation: made.main,
      call: `${made.main}.${made.task}`,
      title: made.title,
      asks: made.asks,
      ...(made.moved ? { moved_from: `r-${made.task}` } : {}),
    });
    host.store(made.task, { type: "user_message", text: words });
    if (made.state !== "queued") {
      host.store(made.task, { type: "reply_started", reply: `r-${made.task}`, model: made.model });
      if (made.plan.length)
        host.store(made.task, {
          type: "step_finished",
          reply: `r-${made.task}`,
          text: "",
          cost_micros: made.costMicros,
          calls: [
            {
              id: `plan-${made.task}`,
              name: "task_plan",
              arguments: { items: made.plan.map((item) => item.text) },
            },
          ],
        });
    }
    host.store(made.main, {
      type: "lane_started",
      lane: made.task,
      conversation: made.task,
      title: made.title,
      call: `${made.main}.${made.task}`,
      asks: made.asks,
      ...(made.moved ? { moved_from: `r-${made.task}` } : {}),
      ...(made.state === "queued" ? { queued: true } : {}),
    });
    if (made.moved)
      host.store(made.main, {
        type: "reply_moved",
        reply: `r-${made.task}`,
        lane: made.task,
        title: made.title,
        asks: made.asks,
      });
    return made;
  }

  /** The lane ended: its reply closes, and its report is stored in main once. */
  settle(task: string, state: "done" | "finished" | "failed" | "stopped", words: string): void {
    const lane = this.lanes.get(task);
    if (!lane) return;
    lane.state = state;
    lane.endedMs = this.#host.now();
    lane.endedSeq = ++this.#ends;
    lane.report = words;
    const host = this.#host;
    const closed =
      state === "failed"
        ? { type: "reply_failed", reply: `r-${task}`, text: words, error: words }
        : state === "stopped"
          ? { type: "reply_stopped", reply: `r-${task}`, text: words }
          : { type: "reply_finished", reply: `r-${task}`, text: words, cost_micros: 0 };
    host.store(task, closed);
    host.store(lane.main, {
      type: "worker_reported",
      worker: task,
      kind: "lane",
      name: lane.title,
      state,
      epoch: `r-${task}`,
      summary:
        state === "done"
          ? `the check of its goal passed (${lane.plan.length} of ${lane.plan.length} items verified).`
          : state === "failed"
            ? "its reply failed."
            : state === "stopped"
              ? "it was stopped."
              : "it ended its turn with no goal checked.",
      ...(state === "stopped" ? {} : { words }),
      // A failure's error is the endpoint's or a tool's, quoted as untrusted: never Spade's.
      ...(state === "failed" ? { error: words, untrusted: true } : {}),
    }); // Its requests still open in main close with it, listed by main's ids (ADR 0217 §4).
    const calls = this.#openRequests(lane, state === "stopped");
    if (calls.length) host.store(lane.main, { type: "lane_requests_closed", lane: task, calls });
  }

  /**
   * Main's ids of `lane`'s requests still open there: approvals not answered and cards waiting on
   * the person, and its deferred cards too when it was stopped (otherwise a deferred card stays
   * answerable, and its answer reopens the task).
   */
  #openRequests(lane: FakeLane, withDeferred: boolean): string[] {
    const events = this.#host.events(lane.main);
    const settled = (call: unknown) =>
      events.some(
        (event) =>
          event.call_id === call &&
          (event.type === "approval_answered" ||
            event.type === "question_answered" ||
            event.type === "question_dismissed"),
      );
    const deferred = (call: unknown) =>
      events.some((event) => event.call_id === call && event.type === "question_deferred");
    return events.flatMap((event) => {
      const of = event.lane as { task?: unknown } | undefined;
      if (of?.task !== lane.task) return [];
      if (event.type !== "approval_requested" && event.type !== "question_asked") return [];
      const call = event.call_id;
      if (typeof call !== "string" || settled(call)) return [];
      if (event.type === "question_asked" && deferred(call) && !withDeferred) return [];
      return [call];
    });
  }

  /** A lane's call waits on the person: asked in the lane, and in main naming the lane. */
  ask(task: string, call: string, name: string, args: Json): void {
    const lane = this.lanes.get(task);
    if (!lane) return;
    lane.state = "needs_you";
    const asked = { name, arguments: args, reviewer_reason: null };
    this.#host.store(task, {
      type: "approval_requested",
      reply: `r-${task}`,
      call_id: call,
      ...asked,
    });
    this.#host.store(lane.main, {
      type: "approval_requested",
      reply: `r-${task}`,
      call_id: `${task}.${call}`,
      ...asked,
      lane: { task, conversation: task, call_id: call, title: lane.title },
    });
    this.#host.store(lane.main, {
      type: "worker_reported",
      worker: task,
      kind: "lane",
      name: lane.title,
      state: "needs_you",
      epoch: `r-${task}`,
      summary: "it waits on you to allow a step.",
    });
  }

  /** Stops every lane of `main` that hasn't ended, queued ones too; how many it stopped. */
  stopAll(main: string): number {
    let stopped = 0;
    for (const lane of this.lanes.values())
      if (lane.main === main && live(lane.state)) {
        this.settle(lane.task, "stopped", "");
        stopped++;
      }
    return stopped;
  }

  /**
   * A lane's call answered in main (`<lane>.<call>`): the answer reaches the lane, which works on
   * (or carries on without the step).
   */
  answered(callId: string, allowed: boolean): void {
    const lane = this.#owner(callId);
    if (!lane || lane.state !== "needs_you") return;
    const at = lane.task.length;
    lane.state = "working";
    this.#host.store(lane.task, {
      type: "approval_answered",
      reply: `r-${lane.task}`,
      call_id: callId.slice(at + 1),
      allowed,
      always: false,
    });
  }

  /**
   * A lane's card of one question waits on the person: asked in the lane, and in main naming the
   * lane (call id `<lane>.<call>`), where it is answered.
   */
  askQuestion(task: string, call: string, question: string): void {
    const lane = this.lanes.get(task);
    if (!lane) return;
    lane.state = "needs_you";
    const asked = { type: "question_asked", reply: `r-${task}`, question };
    this.#host.store(task, { ...asked, call_id: call });
    this.#host.store(lane.main, {
      ...asked,
      call_id: `${task}.${call}`,
      lane: { task, conversation: task, call_id: call, title: lane.title },
    });
  }

  /** A lane's card answered in main: the answer reaches the lane, which works on. */
  questionAnswered(callId: string, answers: unknown[]): void {
    const lane = this.#owner(callId);
    if (!lane) return;
    lane.state = "working";
    this.#host.store(lane.task, {
      type: "question_answered",
      call_id: callId.slice(lane.task.length + 1),
      answers,
    });
  }

  /** The title role named a lane (ADR 0217 §2a): stored in main and in the lane. */
  retitle(task: string, title: string): void {
    const lane = this.lanes.get(task);
    if (!lane) return;
    lane.title = title;
    for (const conversation of [lane.main, task])
      this.#host.store(conversation, { type: "lane_titled", lane: task, title });
  }

  /** Two running lanes wrote one file (ADR 0217 §3): main's note. */
  overlapped(task: string, other: string, path: string): void {
    const lane = this.lanes.get(task);
    const second = this.lanes.get(other);
    if (!lane || !second) return;
    this.#host.store(lane.main, {
      type: "lanes_overlapped",
      lane: task,
      title: lane.title,
      path,
      other,
      other_title: second.title,
    });
  }

  /** Try again on a lane's failed reply: it works again. */
  retried(task: string): void {
    const lane = this.lanes.get(task);
    if (!lane) return;
    lane.state = "working";
    delete lane.endedMs;
    delete lane.report;
  }

  /** `GET /v1/conversations/{lane}/task`: its goal and plan, as `/v1/agents/{id}/task` reads. */
  task(id: string): FakeSpadeAnswer {
    const lane = this.lanes.get(id);
    if (!lane) return reply({ error: "Not a task." }, 404);
    if (!lane.plan.length) return reply({ task: null });
    const done = lane.plan.filter((item) => item.done).length;
    const working = lane.plan.findIndex((item) => !item.done);
    const checked = lane.state === "done";
    return reply({
      task: {
        goal: {
          id: "g1",
          title: lane.goal ?? lane.title,
          text: lane.words,
          criteria: (lane.criteria ?? []).map((text, at) => ({ id: String(at + 1), text })),
          by: "bot",
        },
        items: lane.plan.map((item, at) => ({
          id: String(at + 1),
          text: item.text,
          status: item.done ? "done" : at === working && live(lane.state) ? "working" : "open",
          evidence: item.evidence ? [{ kind: "file", path: item.evidence }] : [],
          verified: item.done && checked,
        })),
        verdict: null,
        checkpoint: null,
        progress: {
          state: checked ? "done" : "working",
          items_total: lane.plan.length,
          items_closed: done,
          items_verified: checked ? done : 0,
        },
      },
    });
  }

  /** The lane a call id asked in main names (`<lane>.<call>`). */
  #owner(callId: string): FakeLane | undefined {
    for (const lane of this.lanes.values()) if (callId.startsWith(`${lane.task}.`)) return lane;
    return undefined;
  }

  /** `GET /v1/conversations/{main}/tasks?ended=N`. */
  tasks(main: string, ended = 20): FakeSpadeAnswer {
    const mine = [...this.lanes.values()].filter((lane) => lane.main === main);
    // Every lane that hasn't ended, and the `ended` that ended last.
    const last = new Set(
      mine
        .filter((lane) => !live(lane.state))
        .toSorted(
          (a, b) => (b.endedMs ?? 0) - (a.endedMs ?? 0) || (b.endedSeq ?? 0) - (a.endedSeq ?? 0),
        )
        .slice(0, Math.max(0, Math.min(ended, 500))),
    );
    const rows = mine
      .filter((lane) => live(lane.state) || last.has(lane))
      .toSorted((a, b) => rank[a.state] - rank[b.state] || a.startedMs - b.startedMs)
      .map((lane) => {
        const done = lane.plan.filter((item) => item.done).length;
        const step = lane.plan.find((item) => !item.done)?.text;
        return {
          task: lane.task,
          conversation: lane.task,
          title: lane.title,
          state: lane.state,
          needs_you: lane.state === "needs_you",
          progress: lane.plan.length
            ? { done, total: lane.plan.length, verified: lane.state === "done" ? done : 0 }
            : null,
          plan_step: live(lane.state) ? (step ?? null) : null,
          started_ms: lane.startedMs,
          ended_ms: live(lane.state) ? null : (lane.endedMs ?? null),
          cost_micros: lane.costMicros,
          asks: lane.asks,
          moved: lane.moved,
          model: lane.model,
          report: live(lane.state) ? null : (lane.report?.split("\n")[0] ?? null),
        };
      });
    return reply({ tasks: rows });
  }
}
