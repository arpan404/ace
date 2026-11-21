import { expect, test } from "vitest";
import { suggestionOffer } from "./pr-suggestions.ts";

const github = { forge: "github" as const };
const suggesting = { kind: "inline", body: "Tighter:\n\n```suggestion\nconst a = 1;\n```" };

test("a suggestion on the current diff can be committed; an outdated one goes to the agent", () => {
  expect(suggestionOffer(suggesting, false, github)).toEqual({
    lines: ["const a = 1;"],
    commit: true,
  });
  expect(suggestionOffer(suggesting, true, github)).toEqual({
    lines: ["const a = 1;"],
    commit: false,
  });
});

test("nothing is offered without one suggestion block on a line comment the host can apply", () => {
  expect(suggestionOffer({ kind: "inline", body: "Rename this?" }, false, github)).toBeUndefined();
  expect(suggestionOffer({ ...suggesting, kind: "issue" }, false, github)).toBeUndefined();
  expect(
    suggestionOffer(suggesting, false, { capabilities: ["reviews.comments.write"] }),
  ).toBeUndefined();
});
