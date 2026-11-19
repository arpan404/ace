import { describe, expect, test } from "vitest";
import { parseSpadeAgentValue } from "./agents.ts";
import { spadeTaskLine } from "./autonomy.ts";
import { spadeBubbles } from "./bubbles.ts";
import { emptySpadeConversation, foldSpade } from "./fold.ts";
import { spadeView } from "./view.ts";
import { parseSpadeEvent } from "./wire.ts";

const agent = (fields: Record<string, unknown>) =>
  parseSpadeAgentValue({
    id: "flights",
    name: "Flights",
    model: "m/x",
    conversation: "c",
    ...fields,
  });

describe("a task that carries on", () => {
  test("a bot carrying on by itself says it is working on it, with its step", () => {
    const bot = agent({
      task_state: { status: "working", note: "Checking easyJet" },
      continuing: true,
    });
    expect(spadeTaskLine("Flights", bot?.progress)).toEqual({
      sentence: "Flights is working on it",
      step: "Checking easyJet",
      tone: "working",
    });
  });

  test("the step comes from the object form or the live status when the field has none", () => {
    const bot = agent({ task_state: { status: "working" }, continuing: true });
    expect(spadeTaskLine("Flights", bot?.progress, "Reading fares")?.step).toBe("Reading fares");
  });

  test("a task waiting on the person says the bot needs you", () => {
    const bot = agent({ task_state: { status: "blocked_on_person" } });
    expect(spadeTaskLine("Flights", bot?.progress)?.sentence).toBe("Flights needs you");
  });

  test("a done task, a bot only answering a message, and an older Spade show nothing", () => {
    expect(
      spadeTaskLine(
        "Flights",
        agent({ task_state: { status: "done" }, continuing: true })?.progress,
      ),
    ).toBe(undefined);
    expect(
      spadeTaskLine("Flights", agent({ task_state: { status: "working" } })?.progress),
    ).toBeUndefined();
    expect(spadeTaskLine("Flights", agent({})?.progress)).toBeUndefined();
  });
});

/** A request for `sh build.sh`, put to the person by `stopped` with `reason`. */
const asked = (reason: string, stopped: string) => ({
  type: "approval_requested",
  reply: "r",
  call_id: "k",
  name: "shell",
  arguments: { command: "sh build.sh" },
  reviewer_reason: reason,
  stopped,
});

/** A request as this client reads it off the wire, stopped by `stopped`. */
const read = (stopped: string) =>
  parseSpadeEvent({
    type: "approval_requested",
    reply: "r",
    call_id: "k",
    name: "send_email",
    stopped,
  });

describe("escalations", () => {
  test("an approval the reviewer escalated carries the reviewer's reason", () => {
    const state = emptySpadeConversation();
    foldSpade(state, {
      kind: "stored",
      stored: { seq: 1, at: 1, event: { type: "reply_started", reply: "r" } },
    });
    foldSpade(state, {
      kind: "stored",
      stored: {
        seq: 2,
        at: 2,
        event: {
          type: "approval_requested",
          reply: "r",
          call_id: "k",
          name: "send_email",
          reviewer_reason: "It sends as you to someone new",
        },
      },
    });
    expect(state.approvals[0]?.reason).toBe("It sends as you to someone new");
  });

  test("a call asked about again after the person allowed it is open again, with the new reason", () => {
    const state = emptySpadeConversation();
    let seq = 0;
    // Each event as it comes off the wire.
    const store = (event: Record<string, unknown>) =>
      foldSpade(state, {
        kind: "stored",
        stored: { seq: ++seq, at: seq, event: parseSpadeEvent(event) },
      });
    const open = () =>
      spadeBubbles(spadeView(state)).flatMap((bubble) =>
        bubble.kind === "ask" ? [{ reason: bubble.reason, stopped: bubble.stopped }] : [],
      );
    store({ type: "reply_started", reply: "r" });
    store({ type: "step_finished", reply: "r", text: "", calls: [{ id: "k", name: "shell" }] });
    store(asked("The reviewer stopped this: It rebuilds everything.", "reviewer"));
    expect(open()).toEqual([
      { reason: "The reviewer stopped this: It rebuilds everything.", stopped: "reviewer" },
    ]);
    store({ type: "approval_answered", reply: "r", call_id: "k", allowed: true, always: false });
    expect(open()).toEqual([]);
    // Its script changed before it started: the old answer doesn't run it, the person decides again.
    const changed = "A file this command runs changed after it was checked, so you decide on it.";
    store(asked(changed, "changed"));
    expect(open()).toEqual([{ reason: changed, stopped: "changed" }]);
  });

  test("a judge this client doesn't know reads as no judge, and the request still stands", () => {
    expect(read("reviewer")).toMatchObject({ type: "approval_requested", stopped: "reviewer" });
    const unknown = read("a_newer_judge");
    expect(unknown).toMatchObject({ type: "approval_requested", call_id: "k" });
    expect(unknown).not.toHaveProperty("stopped", "a_newer_judge");
  });
});

const waitingLine = (continuing: boolean) =>
  spadeTaskLine(
    "Flights",
    agent({ task_state: { status: "waiting", note: "Waiting on the fare alert" }, continuing })
      ?.progress,
    "Thinking",
  );

test("a task waiting on something else says the bot is waiting, with its note", () => {
  const waiting = {
    sentence: "Flights is waiting",
    step: "Waiting on the fare alert",
    tone: "waiting",
  };
  // With a step Spade will start, and without one: either way it waits, it isn't working.
  expect(waitingLine(true)).toEqual(waiting);
  expect(waitingLine(false)).toEqual(waiting);
});
