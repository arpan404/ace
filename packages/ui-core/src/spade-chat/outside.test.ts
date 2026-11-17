import { describe, expect, test } from "vitest";
import {
  emptySpadeConversation,
  foldSpade,
  parseSpadeLiveFrame,
  spadeBubbles,
  spadeView,
  type SpadeConversationState,
} from "./index.ts";

/** A conversation folded from stored `events`, and the outside-the-sandbox cards it shows. */
function cards(events: Record<string, unknown>[]) {
  const state: SpadeConversationState = emptySpadeConversation();
  events.forEach((event, at) => {
    const input = parseSpadeLiveFrame("stored", JSON.stringify({ seq: at + 1, at: 1000, event }));
    if (input) foldSpade(state, input);
  });
  return spadeBubbles(spadeView(state)).filter((bubble) => bubble.kind === "plugin-outside");
}

const asked = {
  type: "plugin_outside_asked",
  id: "outside1",
  plugin: "lint",
  version: "1.0",
  hash: "a".repeat(64),
  what: "server checks",
  line: "lint needs the network, and Windows can't seal that off yet. Run it outside the sandbox?",
  key: "k",
};

describe("a plugin asking to run outside the sandbox (ADR 0167)", () => {
  test("shows its card with Spade's sentence until the person answers, even after the reply ends", () => {
    const open = cards([
      { type: "reply_started", reply: "r1" },
      asked,
      { type: "reply_finished", reply: "r1", text: "Done." },
    ]);
    expect(open).toEqual([
      expect.objectContaining({
        kind: "plugin-outside",
        id: "outside1",
        plugin: "lint",
        what: "server checks",
        line: asked.line,
      }),
    ]);
  });

  test.each([true, false])("leaves once answered (allowed: %s)", (allowed) => {
    expect(cards([asked, { type: "plugin_outside_answered", id: "outside1", allowed }])).toEqual(
      [],
    );
  });
});
