import { describe, expect, test } from "vitest";
import {
  emptySpadeConversation,
  foldSpade,
  parseSpadeLiveFrame,
  spadeAnswerWords,
  spadeBubbles,
  spadeCardAnswers,
  spadeCardQuestions,
  spadeForLaterWords,
  spadePickCount,
  spadeRefusedQuestion,
  spadeView,
  type SpadeQuestion,
} from "./index.ts";

function conversation() {
  const state = emptySpadeConversation();
  let seq = 0;
  const stored = (event: Record<string, unknown>) => {
    const input = parseSpadeLiveFrame("stored", JSON.stringify({ seq: ++seq, at: 1000, event }));
    if (input) foldSpade(state, input);
  };
  const cards = () =>
    spadeBubbles(spadeView(state)).flatMap((bubble) =>
      bubble.kind === "question" ? [bubble] : [],
    );
  const said = () =>
    spadeBubbles(spadeView(state)).map((bubble) =>
      bubble.kind === "question"
        ? `card ${bubble.callId} ${bubble.standing}`
        : bubble.kind === "bot" || bubble.kind === "person"
          ? `${bubble.kind}: ${bubble.text}`
          : bubble.kind,
    );
  return { stored, cards, said, view: () => spadeView(state) };
}

const seatAndNights = [
  {
    prompt: "Window or aisle?",
    kind: "choice",
    options: [{ label: "Window" }, { label: "Aisle", detail: "Easier to get out" }],
    other: true,
  },
  { prompt: "How many nights?", kind: "number", min: 1, max: 14, unit: "nights" },
];

/** A reply that says something, then asks the card `q1`. */
function asks(c: ReturnType<typeof conversation>, questions: unknown = seatAndNights) {
  c.stored({ type: "reply_started", reply: "r1" });
  c.stored({
    type: "step_finished",
    reply: "r1",
    text: "Found two flights.",
    calls: [{ id: "q1", name: "ask_user" }],
  });
  c.stored({
    type: "question_asked",
    reply: "r1",
    call_id: "q1",
    question: "Window or aisle?\nHow many nights?",
    questions,
  });
}

describe("a card of questions", () => {
  test("is the bot's bubble after the words that asked, each question with its kind", () => {
    const c = conversation();
    asks(c);
    expect(c.said()).toEqual(["bot: Found two flights.", "card q1 waiting"]);
    const [card] = c.cards();
    expect(card?.questions).toEqual([
      {
        id: undefined,
        prompt: "Window or aisle?",
        kind: "choice",
        options: [
          { label: "Window", detail: undefined },
          { label: "Aisle", detail: "Easier to get out" },
        ],
        other: true,
      },
      {
        id: undefined,
        prompt: "How many nights?",
        kind: "number",
        min: 1,
        max: 14,
        unit: "nights",
      },
    ]);
    expect(c.view()).toMatchObject({ asking: true, busy: true });
  });

  test("answered in the card, it keeps the answers in place and the bot goes on", () => {
    const c = conversation();
    asks(c);
    c.stored({ type: "question_answered", call_id: "q1", answers: ["Aisle", 3] });
    c.stored({ type: "step_finished", reply: "r1", text: "Booked." });
    c.stored({ type: "reply_finished", reply: "r1", text: "Booked." });
    expect(c.said()).toEqual(["bot: Found two flights.", "card q1 answered", "bot: Booked."]);
    expect(c.cards()[0]?.answers).toEqual(["Aisle", 3]);
    expect(c.view().asking).toBe(false);
  });

  test("left for later, it blocks nothing, counts until answered late, and survives the turn's end", () => {
    const c = conversation();
    asks(c);
    c.stored({ type: "question_deferred", call_id: "q1" });
    // One card of two questions: two questions for later.
    expect(c.view()).toMatchObject({ asking: false, forLater: ["q1"], questionsForLater: 2 });
    c.stored({ type: "reply_finished", reply: "r1", text: "" });
    expect(c.said()).toEqual(["bot: Found two flights.", "card q1 deferred"]);
    expect(c.view().busy).toBe(false);

    c.stored({ type: "question_answered", call_id: "q1", answers: ["Window", 2], late: true });
    expect(c.said()).toEqual(["bot: Found two flights.", "card q1 answered"]);
    expect(c.view()).toMatchObject({ forLater: [], questionsForLater: 0 });
  });

  test("asked without waiting, it is for later from the start", () => {
    const c = conversation();
    asks(c);
    c.stored({ type: "question_deferred", call_id: "q1", by_bot: true });
    expect(c.cards()[0]).toMatchObject({ standing: "deferred", askedForLater: true });
  });

  test("Never mind dismisses it, waiting or later; a stopped turn closes a waiting one", () => {
    const later = conversation();
    asks(later);
    later.stored({ type: "question_deferred", call_id: "q1" });
    later.stored({ type: "question_dismissed", call_id: "q1", late: true });
    expect(later.cards()[0]?.standing).toBe("dismissed");
    expect(later.view().forLater).toEqual([]);

    const stopped = conversation();
    asks(stopped);
    stopped.stored({ type: "stop_requested", reply: "r1", jobs: [] });
    stopped.stored({ type: "reply_stopped", reply: "r1", text: "" });
    expect(stopped.cards()[0]?.standing).toBe("closed");
  });

  test("a message the person types answers a waiting card, with what it stood for when it could", () => {
    const c = conversation();
    asks(c, [{ prompt: "Which airport?", kind: "text" }]);
    c.stored({ type: "user_message", text: "Heathrow" });
    expect(c.cards()[0]).toMatchObject({ standing: "answered", typed: true, answers: undefined });
    c.stored({ type: "question_answered", call_id: "q1", answers: ["Heathrow"], typed: true });
    expect(c.cards()[0]).toMatchObject({ standing: "answered", answers: ["Heathrow"] });
    // A deferred card isn't answered by a message.
    const later = conversation();
    asks(later);
    later.stored({ type: "question_deferred", call_id: "q1" });
    later.stored({ type: "user_message", text: "Aisle" });
    expect(later.cards()[0]?.standing).toBe("deferred");
  });

  test("a replayed ask leaves the card where and as it stands", () => {
    const c = conversation();
    asks(c);
    c.stored({ type: "question_deferred", call_id: "q1" });
    c.stored({ type: "question_asked", reply: "r1", call_id: "q1", question: "Again?" });
    expect(c.said()).toEqual(["bot: Found two flights.", "card q1 deferred"]);
  });
});

describe("reading a card", () => {
  test("an older card, or one with nothing readable, is one text question of its words", () => {
    expect(spadeCardQuestions(undefined, "Which airport?")).toEqual([
      { id: undefined, prompt: "Which airport?", kind: "text", placeholder: undefined },
    ]);
    expect(spadeCardQuestions([{ nope: 1 }], "Which airport?")).toHaveLength(1);
    // A kind this client doesn't know is asked as text; Spade checks the answer.
    expect(spadeCardQuestions([{ prompt: "Colour?", kind: "colour" }], "")[0]?.kind).toBe("text");
    // Bare strings are options' labels.
    expect(
      spadeCardQuestions([{ prompt: "Pick", kind: "choice", options: ["A", "B"] }], ""),
    ).toMatchObject([{ options: [{ label: "A" }, { label: "B" }] }]);
  });

  test("answers read as the person would say them", () => {
    const [seat, nights] = spadeCardQuestions(seatAndNights, "");
    if (!seat || !nights) throw new Error("no questions");
    expect(spadeAnswerWords(seat, "Aisle")).toBe("Aisle");
    expect(spadeAnswerWords(nights, 3)).toBe("3 nights");
    expect(spadeAnswerWords({ ...seat, kind: "confirm" }, false)).toBe("No");
    expect(spadeAnswerWords(seat, ["Tea", "Coffee"])).toBe("Tea, Coffee");
    expect(spadeForLaterWords(1)).toBe("1 question for later");
    expect(spadeForLaterWords(3)).toBe("3 questions for later");
  });
});

describe("a refusal from Spade", () => {
  test("turns the card to the question it names, and only to one the card has", () => {
    expect(spadeRefusedQuestion("Question 2: pick 1 to 2; this picks 3.", 2)).toBe(1);
    expect(spadeRefusedQuestion("Question 3: it has no answer.", 2)).toBeUndefined();
    expect(spadeRefusedQuestion("This question isn't open anymore.", 2)).toBeUndefined();
  });
});

describe("a draft", () => {
  const meals: SpadeQuestion = {
    id: undefined,
    prompt: "Which meals?",
    kind: "choices",
    options: ["Breakfast", "Lunch", "Dinner"].map((label) => ({ label, detail: undefined })),
    min: 1,
    max: 2,
    other: false,
  };

  test("picks count against the most a question takes, and go in option order", () => {
    expect(spadePickCount(meals, { kind: "picks", picked: ["Dinner"], other: "" })).toBe("1 of 2");
    expect(
      spadeCardAnswers([meals], [{ kind: "picks", picked: ["Dinner", "Breakfast"], other: "" }]),
    ).toEqual({ answers: [["Breakfast", "Dinner"]] });
    expect(
      spadeCardAnswers(
        [meals],
        [{ kind: "picks", picked: ["Dinner", "Lunch", "Breakfast"], other: "" }],
      ),
    ).toEqual({ missing: "Pick at most 2", at: 0 });
  });

  test("Send waits for every question, a number in range and a real date shape", () => {
    const [seat, nights] = spadeCardQuestions(seatAndNights, "");
    if (!seat || !nights) throw new Error("no questions");
    const date: SpadeQuestion = { id: undefined, prompt: "When?", kind: "date", time: false };
    expect(
      spadeCardAnswers(
        [seat, nights],
        [
          { kind: "picks", picked: [], other: "Middle, sadly" },
          { kind: "field", text: "20" },
        ],
      ),
    ).toEqual({ missing: "At most 14", at: 1 });
    expect(
      spadeCardAnswers(
        [seat, nights, date],
        [
          { kind: "picks", picked: ["Aisle"], other: "" },
          { kind: "field", text: "3" },
          { kind: "field", text: "2026-12-01" },
        ],
      ),
    ).toEqual({ answers: ["Aisle", 3, "2026-12-01"] });
    expect(spadeCardAnswers([date], [{ kind: "field", text: "next week" }])).toEqual({
      missing: "Pick a date",
      at: 0,
    });
  });
});
