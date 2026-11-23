import { marketPickFixture } from "@ace/fake-daemon";
import type { MarketDraftCheck, MarketPrivacySpan } from "@ace/protocol/marketplace";
import { expect, test } from "vitest";
import { confirmationOf } from "./market-publish-words.ts";

function span(text: string, kind: MarketPrivacySpan["kind"]): MarketPrivacySpan {
  return { start: 0, end: text.length, text, kind, sentence: "Flagged text." };
}

test("confirmation includes reviewed text and leaves out secrets and blocking findings", () => {
  const recipe = marketPickFixture().recipes?.a_inbox?.recipe;
  if (!recipe) throw new Error("Expected the inbox bot recipe");
  const check: MarketDraftCheck = {
    hash: "a".repeat(64),
    files: [],
    excluded: [],
    findings: [
      {
        path: "notes.txt",
        kind: "hidden-text",
        text: "Hidden content",
        sentence: "Hidden text must be removed.",
        blocking: true,
      },
      {
        path: "notes.txt",
        kind: "email",
        text: "bot@example.test",
        sentence: "This email address would be public.",
        blocking: false,
      },
    ],
    bot: {
      recipe,
      leftOut: [],
      name: [span(recipe.name, "own-name")],
      task: [span("Synthetic secret", "secret")],
      routines: [],
    },
  };

  expect(confirmationOf(check, [], undefined).accepted).toEqual(["bot@example.test", recipe.name]);
});
