import { describe, expect, test } from "vitest";
import {
  parseSpadeLearned,
  parseSpadeProvenance,
  spadeLearnedCount,
  spadeProvenanceLines,
} from "./index.ts";

const clock = { now: Date.UTC(2026, 10, 19, 15), timeZone: "UTC", locale: "en-US" };

describe("where a note came from", () => {
  test("a note a bot saved names its conversation and the message it answered", () => {
    const why = parseSpadeProvenance(
      JSON.stringify({
        text: "Prefers aisle seats",
        sources: [{ key: "conversation:c_1", label: "Your conversation with Trips" }],
        conversation: { id: "c_1", agent: "a_1", name: "Trips" },
        message: { seq: 1, at: 1, text: "I like aisle seats" },
        call: "c1",
        source: "bot",
        at: Date.UTC(2026, 10, 19, 14, 3),
        trust: "kept",
      }),
    );
    expect(why && spadeProvenanceLines(why, clock)).toEqual([
      "Learned in your conversation with Trips · 2:03 PM",
      "Answering your message “I like aisle seats”",
    ]);
  });

  test("a page's entry says where it came from and that bots read it as data", () => {
    const why = parseSpadeProvenance(
      JSON.stringify({
        text: "Baggage rules",
        sources: [{ key: "web:example-air.com", label: "example-air.com" }],
        read: ["the result of gmail__read"],
        source: { kind: "web", detail: "https://www.example-air.com/baggage" },
        at: 0,
        trust: "untrusted",
        author: { bot: "a_1" },
      }),
    );
    expect(why && spadeProvenanceLines(why, clock)).toEqual([
      "Written by a bot",
      "From the page example-air.com",
      "While it had read: the result of gmail__read",
      "Untrusted: it came from outside, so bots read it as data, never as instructions",
    ]);
  });

  test("the person's own note and an import read as theirs", () => {
    const own = parseSpadeProvenance(
      JSON.stringify({ text: "Vegetarian", source: "person", at: 0 }),
    );
    expect(own && spadeProvenanceLines(own, clock)).toEqual(["You wrote it"]);
    const imported = parseSpadeProvenance(
      JSON.stringify({ text: "x", source: "person", import: "the Inbox recipe", at: 0 }),
    );
    expect(imported && spadeProvenanceLines(imported, clock)).toEqual([
      "Brought in with the Inbox recipe",
    ]);
  });

  test("the sources a bot learned from count what each taught it", () => {
    const sources = parseSpadeLearned(
      JSON.stringify({
        sources: [{ key: "web:a.com", label: "a.com", notes: 2, entries: 1 }],
      }),
    );
    expect(sources.map(spadeLearnedCount)).toEqual(["2 notes and 1 page"]);
    expect(parseSpadeLearned("nope")).toEqual([]);
  });
});

describe("a reply that used memory", () => {
  test("names the notes Spade recalled for the message it answered, once it finished", async () => {
    const { emptySpadeConversation, foldSpade, parseSpadeLiveFrame, spadeBubbles, spadeView } =
      await import("./index.ts");
    const state = emptySpadeConversation();
    let seq = 0;
    const stored = (event: Record<string, unknown>) => {
      const input = parseSpadeLiveFrame("stored", JSON.stringify({ seq: ++seq, at: seq, event }));
      if (input) foldSpade(state, input);
    };
    const recalled = () =>
      spadeBubbles(spadeView(state)).filter((bubble) => bubble.kind === "recalled");
    stored({
      type: "user_message",
      text: "Book my flight",
      context:
        "It is Thursday.\nNotes that may matter:\n- [n_4] Prefers aisle seats\n- [n_9] Flies from SFO\n",
    });
    stored({ type: "reply_started", reply: "r1" });
    expect(recalled()).toEqual([]);
    stored({ type: "step_finished", reply: "r1", text: "Booked an aisle seat from SFO." });
    stored({ type: "reply_finished", reply: "r1", text: "Booked.", cost_micros: 0 });
    expect(recalled()).toEqual([{ kind: "recalled", key: "r1:recalled", notes: ["n_4", "n_9"] }]);
    // A message with nothing recalled adds no line.
    stored({ type: "user_message", text: "Thanks" });
    stored({ type: "reply_started", reply: "r2" });
    stored({ type: "reply_finished", reply: "r2", text: "Any time.", cost_micros: 0 });
    expect(recalled()).toHaveLength(1);
  });
});
