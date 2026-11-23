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
  /** The plan, as `task_plan` left it: each item's words and whether it is done. */
  plan: readonly { text: string; done: boolean }[];
  startedMs: number;
  endedMs?: number;
  costMicros: number;
  asks: readonly string[];
  moved: boolean;
  model: string;
  /** Its last words once it has ended. */
  report?: string;
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
  start(lane: Omit<FakeLane, "startedMs"> & { startedMs?: number; words: string }): FakeLane {
    const { words, ...rest } = lane;
    const made: FakeLane = { ...rest, startedMs: lane.startedMs ?? this.#host.now() };
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
            ? `its reply failed: ${words}.`
            : state === "stopped"
              ? "it was stopped."
              : "it ended its turn with no goal checked.",
      ...(state === "stopped" ? {} : { words }),
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
  }

  /** `GET /v1/conversations/{main}/tasks`. */
  tasks(main: string): FakeSpadeAnswer {
    const rows = [...this.lanes.values()]
      .filter((lane) => lane.main === main)
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

const plan = (texts: readonly string[], done: number) =>
  texts.map((text, at) => ({ text, done: at < done }));

/**
 * Stores a realistic set of lanes for the bot whose conversation is `main`, with the person's
 * messages that asked for them, as `?fakeWorld` and tests use: one waits on the person to pay,
 * two run (one Spade moved from main), one failed, one is done and one waits for a slot.
 */
export function stageFakeLanes(lanes: FakeSpadeLanes, host: FakeLanesHost, main: string): void {
  const now = host.now();
  const minute = 60_000;
  const model = "openai/gpt-5.4";
  const person = (text: string) => host.store(main, { type: "user_message", text });
  person("The March invoice has the VAT line wrong. Fix it and send it to Dana once it's right.");
  lanes.start({
    task: `${main}-lane-invoice`,
    main,
    title: "Fix the March invoice",
    words: "The March invoice has the VAT line wrong. Fix it and send it to Dana once it's right.",
    state: "working",
    plan: plan(
      [
        "Find why the VAT line is wrong",
        "Correct VAT and the totals",
        "Draft the email to Dana",
        "Send it to dana@northwind.co",
        "Save the sent copy",
      ],
      2,
    ),
    startedMs: now - 12 * minute,
    costMicros: 380_000,
    asks: ["m1"],
    moved: false,
    model,
  });
  person("Draft the quarterly note from the numbers in Q3.xlsx.");
  lanes.start({
    task: `${main}-lane-quarterly`,
    main,
    title: "Draft the quarterly note",
    words: "Draft the quarterly note from the numbers in Q3.xlsx.",
    state: "working",
    plan: plan(
      [
        "Read Q3.xlsx",
        "Pull last quarter's note for the sections",
        "Outline the note",
        "Write the revenue section",
        "Write costs and hiring",
        "Check every number against the sheet",
      ],
      3,
    ),
    startedMs: now - 6 * minute,
    costMicros: 610_000,
    asks: ["m4"],
    moved: true,
    model,
  });
  person("Also book flights to Lisbon, out on the 14th and back the 18th. Window seat.");
  const flights = `${main}-lane-flights`;
  lanes.start({
    task: flights,
    main,
    title: "Book flights to Lisbon",
    words: "Also book flights to Lisbon, out on the 14th and back the 18th. Window seat.",
    state: "working",
    plan: plan(
      [
        "Compare fares for the 14th and the 18th",
        "Pick the cheapest with window seats",
        "Fill in the booking",
        "Pay and save the confirmation",
      ],
      3,
    ),
    startedMs: now - 10 * minute,
    costMicros: 220_000,
    asks: ["m8"],
    moved: false,
    model,
  });
  lanes.ask(flights, "k1", "browser_act", {
    action: "click",
    target: "Pay €412 to TAP Air Portugal",
  });
  person("And compare the three CRM quotes in /quotes.");
  const crm = `${main}-lane-crm`;
  lanes.start({
    task: crm,
    main,
    title: "Compare the three CRM quotes",
    words: "And compare the three CRM quotes in /quotes.",
    state: "working",
    plan: plan(
      [
        "Read the Pipedrive and Attio quotes",
        "Put them side by side in crm.md",
        "Check HubSpot's list prices",
      ],
      2,
    ),
    startedMs: now - 4 * minute,
    costMicros: 290_000,
    asks: ["m13"],
    moved: false,
    model,
  });
  lanes.settle(crm, "failed", "HubSpot's pricing page wouldn't load after three tries");
  person("Clean up the shared drive: one folder per client.");
  const drive = `${main}-lane-drive`;
  lanes.start({
    task: drive,
    main,
    title: "Clean up the shared drive",
    words: "Clean up the shared drive: one folder per client.",
    state: "working",
    plan: plan(
      [
        "List every file and its client",
        "Move them into one folder per client",
        "Check nothing was left at the top",
      ],
      3,
    ),
    startedMs: now - 5 * minute,
    costMicros: 170_000,
    asks: ["m19"],
    moved: false,
    model,
  });
  lanes.settle(drive, "done", "214 files in six client folders; nothing deleted.");
  person("Then renew the domain before it lapses.");
  lanes.start({
    task: `${main}-lane-domain`,
    main,
    title: "Renew the domain",
    words: "Then renew the domain before it lapses.",
    state: "queued",
    plan: [],
    startedMs: now - minute,
    costMicros: 0,
    asks: ["m25"],
    moved: false,
    model,
  });
}
