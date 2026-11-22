import { expect, test } from "vitest";
import {
  emptySpadeConversation,
  foldSpade,
  parseSpadeLiveFrame,
  spadeBubbles,
  spadeToolWords,
  spadeTurnsWithWork,
  spadeView,
  spadeWithoutWork,
} from "./index.ts";

/** A conversation fed stored events as the live stream sends them. */
function conversation() {
  const state = emptySpadeConversation();
  let seq = 0;
  const stored = (event: Record<string, unknown>) => {
    const input = parseSpadeLiveFrame(
      "stored",
      JSON.stringify({ seq: ++seq, at: 1000 + seq, event }),
    );
    if (input) foldSpade(state, input);
  };
  return { stored, bubbles: () => spadeBubbles(spadeView(state)) };
}

/** Two turns: each runs a command, then answers. */
function twoTurns() {
  const c = conversation();
  for (const reply of ["r1", "r2"]) {
    c.stored({ type: "user_message", text: `Go ${reply}` });
    c.stored({ type: "reply_started", reply });
    c.stored({
      type: "step_finished",
      reply,
      text: "",
      calls: [{ id: `${reply}-c`, name: "shell", arguments: { command: "ls" } }],
    });
    c.stored({ type: "tool_started", reply, call_id: `${reply}-c`, name: "shell" });
    c.stored({
      type: "tool_finished",
      reply,
      call_id: `${reply}-c`,
      name: "shell",
      content: "ok",
      is_error: false,
    });
    c.stored({ type: "step_finished", reply, text: `Done ${reply}.`, calls: [] });
    c.stored({ type: "reply_finished", reply, text: "" });
  }
  return c.bubbles();
}

const kinds = (bubbles: readonly { kind: string }[]) => bubbles.map((each) => each.kind);

test("the chat leaves out each reply's steps until the person shows them", () => {
  const bubbles = twoTurns();
  expect(kinds(bubbles).filter((kind) => kind === "steps")).toHaveLength(2);
  const hidden = spadeWithoutWork(bubbles, { all: false, turns: new Set() });
  expect(kinds(hidden)).toEqual(["person", "bot", "person", "bot"]);

  // Show work on one reply brings back that turn's steps, under it, and only them.
  const [first] = [...spadeTurnsWithWork(bubbles)];
  const one = spadeWithoutWork(bubbles, { all: false, turns: new Set([first ?? ""]) });
  expect(kinds(one)).toEqual(["person", "bot", "steps", "person", "bot"]);
  const lastBot = bubbles.findLast((bubble) => bubble.kind === "bot");
  expect(lastBot?.kind === "bot" && lastBot.turn).not.toBe(first);

  // Show work in chat brings back every turn's.
  expect(spadeWithoutWork(bubbles, { all: true, turns: new Set() })).toEqual(bubbles);
});

test("what a reply had in mind is work too, hidden with its steps", () => {
  const c = conversation();
  c.stored({
    type: "user_message",
    text: "Plan it",
    context: "Notes:\n- [n_1] Likes trains\n- [n_2] Flies from Leeds",
  });
  c.stored({ type: "reply_started", reply: "r1" });
  c.stored({ type: "step_finished", reply: "r1", text: "Here's the plan.", calls: [] });
  c.stored({ type: "reply_finished", reply: "r1", text: "" });
  const bubbles = c.bubbles();
  expect(kinds(bubbles)).toContain("recalled");
  expect(kinds(spadeWithoutWork(bubbles, { all: false, turns: new Set() }))).toEqual([
    "person",
    "bot",
  ]);
  expect(
    kinds(spadeWithoutWork(bubbles, { all: false, turns: spadeTurnsWithWork(bubbles) })),
  ).toContain("recalled");
});

test("an app's tool reads by its verb, naming the app once", () => {
  expect(spadeToolWords("notion__notion-create-pages").done).toBe("Created pages in Notion");
  expect(spadeToolWords("notion__notion-create-database").base).toBe("create database in Notion");
  expect(spadeToolWords("linear__issue_board").done).toBe("Used issue board in Linear");
  expect(spadeToolWords("ace__thread_start").done).toBe("Used thread start");
});
