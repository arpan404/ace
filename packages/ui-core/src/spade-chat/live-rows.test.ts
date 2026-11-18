import { describe, expect, test } from "vitest";
import {
  emptySpadeConversation,
  emptySpadeGroup,
  foldSpade,
  foldSpadeGroup,
  parseSpadeAgentValue,
  parseSpadeGroups,
  parseSpadeLiveFrame,
  spadeBotRow,
  spadeGroupRow,
  spadeGroupView,
  spadeGroupWithLive,
  spadeLiveAgent,
  spadeLiveGroup,
  spadeView,
  spadeWithLive,
  type SpadeAgent,
} from "./index.ts";

/** A bot's conversation fed live frames, each stored event at the time given. */
function conversation() {
  const state = emptySpadeConversation();
  let seq = 0;
  const frame = (event: string, data: unknown) => {
    const input = parseSpadeLiveFrame(event, JSON.stringify(data));
    if (input) foldSpade(state, input);
  };
  return {
    stored: (at: number, event: Record<string, unknown>) =>
      frame("stored", { seq: ++seq, at, event }),
    caughtUp: () => frame("caught_up", { seq }),
    status: (state: string, status: string | null) => frame("status", { state, status }),
    view: () => spadeView(state),
  };
}

/** The roster's word on a bot, as Spade lists it. */
function listed(fields: Record<string, unknown>): SpadeAgent {
  const agent = parseSpadeAgentValue({
    id: "a1",
    name: "Scout",
    conversation: "c1",
    model: "e/m",
    last_message: { from: "agent", text: "Here is the plan.", at: 1, seq: 1 },
    ...fields,
  });
  if (!agent) throw new Error("unreadable agent");
  return agent;
}

const place = { machine: { primary: true, name: "This Mac" }, away: false, unavailable: false };

/** The list row of `agent` while its conversation shows `view`. */
const row = (agent: SpadeAgent, c: ReturnType<typeof conversation>) =>
  spadeBotRow({ ...spadeWithLive(agent, spadeLiveAgent(c.view())), ...place });

/** A turn that asked a card at 5s and is still waiting on the person. */
function asking() {
  const c = conversation();
  c.stored(1_000, { type: "user_message", text: "Book a flight" });
  c.stored(1_000, { type: "reply_started", reply: "r1" });
  c.stored(5_000, {
    type: "step_finished",
    reply: "r1",
    text: "",
    calls: [{ id: "q1", name: "ask_user" }],
  });
  c.stored(5_000, { type: "question_asked", reply: "r1", call_id: "q1", question: "Window?" });
  c.caughtUp();
  c.status("waiting", "Waiting for you");
  return c;
}

describe("the list row of an open conversation", () => {
  test("shows waiting on you while a question is open, though the roster still says thinking", () => {
    const c = asking();
    const roster = listed({ state: "working", status: "Thinking" });
    expect(row(roster, c)).toEqual({ state: "needs-you", line: "Asked you a question" });
  });

  test("works again as soon as the person answers, though the roster still says asked", () => {
    const c = asking();
    c.stored(50_000, {
      type: "question_answered",
      reply: "r1",
      call_id: "q1",
      answers: [{ question: "Window?", answer: "Aisle" }],
    });
    c.status("working", "Thinking");
    const roster = listed({ state: "waiting", waiting_for: "question", status: "Waiting for you" });
    expect(row(roster, c)).toEqual({ state: "working", line: "Thinking" });
  });

  test("rests once the stream says the turn ended, though the roster still says working", () => {
    const c = asking();
    c.stored(50_000, {
      type: "question_answered",
      reply: "r1",
      call_id: "q1",
      answers: [{ question: "Window?", answer: "Aisle" }],
    });
    c.stored(52_000, { type: "reply_finished", reply: "r1", text: "Booked the aisle." });
    c.status("idle", null);
    const roster = listed({ state: "working", status: "Writing" });
    expect(row(roster, c).state).toBe("rest");
  });

  test("never drops a wait on the person the conversation itself can't see", () => {
    // Nothing of its own is open; one of its workers waits on the person (ADR 0161).
    const c = conversation();
    c.stored(1_000, { type: "user_message", text: "Plan the launch" });
    c.caughtUp();
    c.status("waiting", "A worker is waiting for you");
    const roster = listed({ state: "working", status: "1 worker working" });
    expect(row(roster, c)).toEqual({ state: "needs-you", line: "A worker is waiting for you" });
  });

  test("leaves the roster's word until the stream has caught up", () => {
    const c = conversation();
    c.stored(1_000, { type: "user_message", text: "Plan the launch" });
    const roster = listed({ state: "working", status: "1 worker working" });
    expect(row(roster, c)).toEqual({ state: "working", line: "1 worker working" });
  });
});

describe("the working line's clock", () => {
  test("stops while the bot waits on the person and counts only its own work after", () => {
    const c = asking();
    expect(c.view().working).toMatchObject({ label: "Waiting for you", moving: false });
    // The person took 45s to answer: the clock reads as if the turn began 45s later.
    c.stored(50_000, {
      type: "question_answered",
      reply: "r1",
      call_id: "q1",
      answers: [{ question: "Window?", answer: "Aisle" }],
    });
    expect(c.view().working).toMatchObject({ since: 46_000, moving: true });
  });

  test("leaves out each wait on an approval too, and starts afresh with the next reply", () => {
    const c = conversation();
    c.stored(0, { type: "reply_started", reply: "r1" });
    c.stored(2_000, {
      type: "approval_requested",
      reply: "r1",
      call_id: "c1",
      name: "send_email",
      arguments: {},
    });
    c.stored(12_000, { type: "approval_answered", reply: "r1", call_id: "c1", allowed: true });
    expect(c.view().working?.since).toBe(10_000);
    c.stored(13_000, { type: "reply_finished", reply: "r1", text: "Sent." });
    c.stored(20_000, { type: "reply_started", reply: "r2" });
    expect(c.view().working?.since).toBe(20_000);
  });
});

describe("the list row of an open group", () => {
  const [trips] =
    parseSpadeGroups(
      JSON.stringify({
        groups: [
          {
            id: "g1",
            name: "Trips",
            lead: { agent: "main", machine: null, name: "Spade", away: false },
            members: [{ agent: "main", machine: null, name: "Spade", away: false }],
            conversation: "c-g1",
            state: "working",
            status: "Spade is answering",
            last_message: { from: "person", text: "h", at: 1, seq: 1 },
          },
        ],
      }),
    ) ?? [];

  test("stops saying a member is answering as soon as the stream says the turn ended", () => {
    if (!trips) throw new Error("unreadable group");
    const state = emptySpadeGroup();
    const fold = (event: string, data: unknown) => {
      const input = parseSpadeLiveFrame(event, JSON.stringify(data));
      if (input) foldSpadeGroup(state, input);
    };
    const spade = { id: "main", name: "Spade", machine: null };
    fold("stored", { seq: 1, at: 1, event: { type: "group_message", run: "u1", text: "h" } });
    fold("stored", {
      seq: 2,
      at: 1,
      event: { type: "group_asked", run: "u1", ask: "k1", to: spade, depth: 1 },
    });
    fold("caught_up", { seq: 2 });
    fold("status", { state: "working", status: "Spade is answering" });
    const shown = () =>
      spadeGroupRow({
        ...spadeGroupWithLive(trips, spadeLiveGroup(spadeGroupView(state))),
        ...place,
      });
    expect(shown()).toEqual({ state: "working", line: "Spade is answering" });
    fold("stored", {
      seq: 3,
      at: 2,
      event: { type: "group_answered", run: "u1", ask: "k1", to: spade, outcome: "answered" },
    });
    fold("stored", {
      seq: 4,
      at: 2,
      event: { type: "group_message", run: "u1", text: "Sure.", from: spade },
    });
    fold("status", { state: "idle", status: null });
    expect(shown().state).not.toBe("working");
    expect(shown().line).not.toContain("answering");
  });
});
