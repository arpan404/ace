import { expect, test } from "vitest";
import {
  spadeAggregateReactions,
  spadeFoldReaction,
  type SpadeMessageReactions,
} from "./reactions.ts";

test("a club message's reactions group by emoji, naming each member and the person in first-reacted order", () => {
  const reactions = new Map<string, SpadeMessageReactions>();
  spadeFoldReaction(reactions, { message: "m1", emoji: "👍", by: "bot", agent: "flights" });
  spadeFoldReaction(reactions, { message: "m1", emoji: "❤️", by: "person" });
  spadeFoldReaction(reactions, { message: "m1", emoji: "👍", by: "bot", agent: "inbox" });
  expect(spadeAggregateReactions([reactions.get("m1")])).toEqual([
    { emoji: "👍", by: ["flights", "inbox"] },
    { emoji: "❤️", by: ["person"] },
  ]);
});

test("a member who changes or takes back their reaction leaves only their latest standing", () => {
  const reactions = new Map<string, SpadeMessageReactions>();
  spadeFoldReaction(reactions, { message: "m1", emoji: "👍", by: "bot", agent: "flights" });
  spadeFoldReaction(reactions, { message: "m1", emoji: "🎉", by: "bot", agent: "flights" });
  expect(spadeAggregateReactions([reactions.get("m1")])).toEqual([
    { emoji: "🎉", by: ["flights"] },
  ]);
  spadeFoldReaction(reactions, {
    message: "m1",
    emoji: "",
    by: "bot",
    agent: "flights",
    removed: true,
  });
  expect(reactions.has("m1")).toBe(false);
});
