import { describe, expect, test } from "vitest";
import {
  emptySpadeConversation,
  foldSpade,
  parseSpadeCaseReview,
  parseSpadeCases,
  parseSpadeLiveFrame,
  spadeBubbles,
  spadeCaseMarkWords,
  spadeCaseTriggerWords,
  spadeView,
  type SpadeConversationState,
} from "./index.ts";

function conversation() {
  const state: SpadeConversationState = emptySpadeConversation();
  let seq = 0;
  return {
    stored: (event: Record<string, unknown>) => {
      const input = parseSpadeLiveFrame(
        "stored",
        JSON.stringify({ seq: ++seq, at: 1000 + seq, event }),
      );
      if (input) foldSpade(state, input);
    },
    keepable: () =>
      spadeBubbles(spadeView(state)).flatMap((b) =>
        b.kind === "bot" ? [`${b.text} → ${b.keep ?? "-"}`] : [],
      ),
  };
}

describe("Keep as a test on the chat", () => {
  test("only the last words of a finished reply offer it", () => {
    const c = conversation();
    c.stored({ type: "user_message", text: "Fares?" });
    c.stored({ type: "reply_started", reply: "r1", model: "e/m" });
    c.stored({ type: "step_finished", reply: "r1", text: "Looking.", calls: [] });
    c.stored({ type: "step_finished", reply: "r1", text: "The 9:40 is cheapest." });
    expect(c.keepable()).toEqual(["Looking. → -", "The 9:40 is cheapest. → -"]);
    c.stored({ type: "reply_finished", reply: "r1", text: "The 9:40 is cheapest." });
    expect(c.keepable()).toEqual(["Looking. → -", "The 9:40 is cheapest. → r1"]);
  });

  test("a stopped reply offers nothing", () => {
    const c = conversation();
    c.stored({ type: "user_message", text: "Fares?" });
    c.stored({ type: "reply_started", reply: "r1", model: "e/m" });
    c.stored({ type: "step_finished", reply: "r1", text: "Looking." });
    c.stored({ type: "reply_stopped", reply: "r1", text: "" });
    expect(c.keepable()).toEqual(["Looking. → -"]);
  });
});

describe("a bot's cases", () => {
  test("read from the list, a row that doesn't read left out", () => {
    const cases = parseSpadeCases(
      JSON.stringify({
        cases: [
          {
            id: "case_1",
            reply: "r1",
            mark: "wrong",
            why: "It picked a stop-over",
            trigger: { kind: "routine", name: "Morning fares" },
            given: "Check the fares.",
            outcome: "Nothing new.",
            made_at: 5,
          },
          { reply: "no id" },
        ],
      }),
    );
    expect(cases).toEqual([
      {
        id: "case_1",
        reply: "r1",
        mark: "wrong",
        why: "It picked a stop-over",
        trigger: { kind: "routine", name: "Morning fares" },
        given: "Check the fares.",
        outcome: "Nothing new.",
        madeAt: 5,
      },
    ]);
    expect(parseSpadeCases(JSON.stringify({ nope: [] }))).toBeUndefined();
    expect(parseSpadeCases("not json")).toBeUndefined();
  });

  test("their marks and triggers in words", () => {
    expect(spadeCaseMarkWords("right")).toBe("Marked right");
    expect(spadeCaseMarkWords(undefined)).toBeUndefined();
    expect(spadeCaseTriggerWords({ kind: "routine", name: "Morning fares" })).toBe(
      "From Morning fares",
    );
    expect(spadeCaseTriggerWords({ kind: "contract", name: "cheapest_fare" })).toBe(
      "Asked for cheapest_fare",
    );
    expect(spadeCaseTriggerWords({ kind: "message", name: undefined })).toBeUndefined();
  });

  test("the review lists what it was asked, each outside answer and its answer", () => {
    const lines = parseSpadeCaseReview(
      JSON.stringify({
        case: {
          given: { messages: ["Where is my order?"] },
          tool_results: [
            { tool: "lookup", content: "Order ••• ships Friday" },
            { tool: "mail", content: "timed out", is_error: true },
          ],
          outcome: { text: "It ships Friday." },
        },
      }),
    );
    expect(lines?.map((l) => `${l.label}: ${l.text}`)).toEqual([
      "Asked: Where is my order?",
      "lookup: Order ••• ships Friday",
      "mail failed: timed out",
      "Answered: It ships Friday.",
    ]);
  });
});
