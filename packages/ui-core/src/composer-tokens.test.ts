import { expect, test } from "vitest";
import { composerInput, editComposerTokens, tokensFromInput } from "./index.ts";
import type { CatalogMention, ContentPart } from "@ace/protocol";
const writing: CatalogMention = {
  type: "mention",
  entryId: "global:writing",
  name: "writing",
  kind: "skill",
  arguments: "",
};
const review: CatalogMention = {
  type: "mention",
  entryId: "project:review",
  name: "review",
  kind: "command",
  arguments: "",
  values: { topic: "restarts" },
};
const input: ContentPart[] = [
  { type: "text", text: "Use " },
  writing,
  { type: "text", text: " then " },
  review,
  { type: "text", text: "." },
];
test("editing prose around references preserves their order and command arguments", () => {
  const draft = tokensFromInput(input);
  const text = `Please ${draft.text}`;
  expect(composerInput(text, editComposerTokens(draft.text, text, draft.tokens))).toEqual([
    { type: "text", text: "Please Use " },
    writing,
    { type: "text", text: " then " },
    review,
    { type: "text", text: "." },
  ]);
});
test("deleting one reference leaves the other invocable and editing its name turns it into prose", () => {
  const draft = tokensFromInput(input);
  const text = "Use then review.";
  const tokens = editComposerTokens(draft.text, text, draft.tokens);
  expect(composerInput(text, tokens)).toEqual([
    { type: "text", text: "Use then " },
    review,
    { type: "text", text: "." },
  ]);
  expect(
    composerInput("Use then reviews.", editComposerTokens(text, "Use then reviews.", tokens)),
  ).toEqual([{ type: "text", text: "Use then " }, review, { type: "text", text: "s." }]);
  expect(
    composerInput("Use then recheck.", editComposerTokens(text, "Use then recheck.", tokens)),
  ).toEqual([{ type: "text", text: "Use then recheck." }]);
});
