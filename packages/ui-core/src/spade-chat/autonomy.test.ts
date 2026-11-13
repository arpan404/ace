import { describe, expect, test } from "vitest";
import { parseSpadeAgentValue } from "./agents.ts";
import { spadeTaskLine } from "./autonomy.ts";
import { emptySpadeConversation, foldSpade } from "./fold.ts";

const agent = (fields: Record<string, unknown>) =>
  parseSpadeAgentValue({
    id: "flights",
    name: "Flights",
    model: "m/x",
    conversation: "c",
    ...fields,
  });

describe("access levels", () => {
  test("a bot from before access levels has none, and one it doesn't know reads as none", () => {
    expect(agent({})?.access).toBeUndefined();
    expect(agent({ access: "root" })?.access).toBeUndefined();
    expect(agent({ access: "full_access" })?.access).toBe("full_access");
  });
});

describe("a task that carries on", () => {
  test("a bot carrying on by itself says it is working on it, with its step", () => {
    const bot = agent({ task_state: "working", continuing: true, step: "Checking easyJet" });
    expect(spadeTaskLine("Flights", bot?.progress)).toEqual({
      sentence: "Flights is working on it",
      step: "Checking easyJet",
      tone: "working",
    });
  });

  test("the step comes from the object form or the live status when the field has none", () => {
    const bot = agent({ task_state: { state: "working", continuing: true } });
    expect(spadeTaskLine("Flights", bot?.progress, "Reading fares")?.step).toBe("Reading fares");
  });

  test("a task waiting on the person says the bot needs you", () => {
    const bot = agent({ task_state: "blocked_on_person" });
    expect(spadeTaskLine("Flights", bot?.progress)?.sentence).toBe("Flights needs you");
  });

  test("a done task, a bot only answering a message, and an older Spade show nothing", () => {
    expect(
      spadeTaskLine("Flights", agent({ task_state: "done", continuing: true })?.progress),
    ).toBe(undefined);
    expect(spadeTaskLine("Flights", agent({ task_state: "working" })?.progress)).toBeUndefined();
    expect(spadeTaskLine("Flights", agent({})?.progress)).toBeUndefined();
  });
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
});
