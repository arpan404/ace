import { describe, expect, test } from "vitest";
import {
  emptySpadeConversation,
  foldSpade,
  parseSpadeLiveFrame,
  parseSpadeNote,
  parseSpadeNotes,
  spadeBubbles,
  spadeView,
} from "./index.ts";

/** A conversation fed stored events as the live stream sends them. */
function conversation() {
  const state = emptySpadeConversation();
  let seq = 0;
  const stored = (event: Record<string, unknown>) => {
    const input = parseSpadeLiveFrame("stored", JSON.stringify({ seq: ++seq, at: 1000, event }));
    if (input) foldSpade(state, input);
  };
  const bubbles = () =>
    spadeBubbles(spadeView(state)).map((bubble) =>
      bubble.kind === "remembered"
        ? `remembered: ${bubble.note.text}${bubble.note.shared ? " (shared)" : ""}`
        : bubble.kind === "bot" || bubble.kind === "person"
          ? `${bubble.kind}: ${bubble.text}`
          : bubble.kind,
    );
  return { state, stored, bubbles, view: () => spadeView(state) };
}

function saved(c: ReturnType<typeof conversation>, name: string, content: unknown, error = false) {
  c.stored({
    type: "step_finished",
    reply: "r1",
    text: "Noted.",
    calls: [{ id: "k1", name, arguments: {} }],
  });
  c.stored({ type: "tool_started", reply: "r1", call_id: "k1", name });
  c.stored({ type: "tool_finished", reply: "r1", call_id: "k1", name, content, is_error: error });
}

describe("what a bot remembered", () => {
  test("a saved note reads as one line between the bot's words", () => {
    const c = conversation();
    c.stored({ type: "user_message", text: "I like window seats" });
    c.stored({ type: "reply_started", reply: "r1" });
    saved(
      c,
      "memory_save",
      JSON.stringify({ saved: { id: "n_4", text: "Prefers window seats", shared: true } }),
    );
    c.stored({ type: "step_finished", reply: "r1", text: "I'll book those." });
    c.stored({ type: "reply_finished", reply: "r1", text: "I'll book those." });
    expect(c.bubbles()).toEqual([
      "person: I like window seats",
      "bot: Noted.",
      "remembered: Prefers window seats (shared)",
      "bot: I'll book those.",
    ]);
  });

  test("a rewritten note reads the same way, from the result's value", () => {
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" });
    saved(c, "memory_update", {
      updated: { id: "n_4", text: "Prefers aisle seats", shared: false },
    });
    expect(c.bubbles()).toEqual(["bot: Noted.", "remembered: Prefers aisle seats"]);
  });

  test("a note that already existed, a failed save and other tools show nothing", () => {
    for (const [name, content, error] of [
      ["memory_save", JSON.stringify({ exists: { id: "n_4", text: "Window", shared: false } })],
      [
        "memory_save",
        JSON.stringify({ saved: { id: "n_4", text: "Window", shared: false } }),
        true,
      ],
      ["web_search", JSON.stringify({ saved: { id: "n_4", text: "Window", shared: false } })],
      ["memory_save", "not json"],
    ] as const) {
      const c = conversation();
      c.stored({ type: "reply_started", reply: "r1" });
      saved(c, name, content, error === true);
      expect(c.bubbles()).toEqual(["bot: Noted."]);
    }
  });
});

describe("a question from the bot", () => {
  test("shows as the bot's bubble and the bot waits until the person answers", () => {
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({
      type: "step_finished",
      reply: "r1",
      text: "",
      calls: [{ id: "q1", name: "ask_user" }],
    });
    c.stored({ type: "question_asked", reply: "r1", call_id: "q1", question: "Which airport?" });
    expect(c.bubbles()).toEqual(["bot: Which airport?"]);
    expect(c.view()).toMatchObject({ asking: true, busy: true, working: { moving: false } });
    c.stored({ type: "user_message", text: "Heathrow" });
    expect(c.view().asking).toBe(false);
    c.stored({ type: "step_finished", reply: "r1", text: "Booked from Heathrow." });
    c.stored({ type: "reply_finished", reply: "r1", text: "Booked from Heathrow." });
    expect(c.bubbles()).toEqual([
      "bot: Which airport?",
      "person: Heathrow",
      "bot: Booked from Heathrow.",
    ]);
    expect(c.view()).toMatchObject({ asking: false, busy: false });
  });

  test("another bot's message doesn't answer it; Stop ends the wait", () => {
    const c = conversation();
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({ type: "question_asked", reply: "r1", call_id: "q1", question: "Which airport?" });
    c.stored({ type: "user_message", text: "hi", from_agent: { id: "b", name: "Bee" } });
    expect(c.view().asking).toBe(true);
    c.stored({ type: "stop_requested", reply: "r1", jobs: [] });
    c.stored({ type: "reply_stopped", reply: "r1", text: "" });
    expect(c.view()).toMatchObject({ asking: false, busy: false });
  });
});

describe("notes from the API", () => {
  test("a list keeps the notes it can read and ignores fields it doesn't know", () => {
    const notes = parseSpadeNotes(
      JSON.stringify({
        notes: [
          {
            id: "n_1",
            text: "Lives in Leeds",
            scope: "shared",
            agent: null,
            source: "person",
            x: 1,
          },
          { text: "no id" },
          { id: "n_2", text: "Uses metric", scope: "agent", agent: "travel", source: "later" },
        ],
      }),
    );
    expect(notes?.map((note) => [note.id, note.text, note.scope, note.agent, note.source])).toEqual(
      [
        ["n_1", "Lives in Leeds", "shared", undefined, "person"],
        ["n_2", "Uses metric", "agent", "travel", "unknown"],
      ],
    );
    expect(parseSpadeNotes("{}")).toBeUndefined();
  });

  test("a created note reads bare or under `note`", () => {
    const note = { id: "n_3", text: "Vegetarian", scope: "shared" };
    expect(parseSpadeNote(JSON.stringify(note))?.text).toBe("Vegetarian");
    expect(parseSpadeNote(JSON.stringify({ note }))?.text).toBe("Vegetarian");
  });
});
