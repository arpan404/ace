import { expect, test } from "vitest";
import { composerInput, editComposerTokens, tokensFromInput, withTypedCommand } from "./index.ts";
import type { CatalogEntry, CatalogMention, ContentPart } from "@ace/protocol";
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

test("an attachment-only draft preserves empty text instead of inventing a prompt", () => {
  expect(composerInput("", [])).toEqual([{ type: "text", text: "" }]);
});

const catalog: CatalogEntry[] = [
  {
    id: "skill:review",
    kind: "skill",
    name: "review",
    description: "Review",
    source: { provider: "claude", scope: "global" },
    invocation: { type: "slash", name: "review" },
  },
  {
    id: "ace:add:files",
    kind: "builtin",
    name: "files",
    description: "Files",
    source: { provider: "ace", scope: "ace" },
    invocation: { type: "action", action: "files" },
  },
];
test("a skill name typed at the start of a message is sent as that skill's chip", () => {
  const text = "/review focus on auth";
  expect(composerInput(text, withTypedCommand(text, [], catalog))).toEqual([
    {
      type: "mention",
      entryId: "skill:review",
      name: "review",
      kind: "skill",
      arguments: "",
    },
    { type: "text", text: " focus on auth" },
  ]);
});
test("unknown names, client actions, mid-message slashes and paths stay plain text", () => {
  for (const text of ["/reviews now", "/files", "please /review", "/review/x"])
    expect(composerInput(text, withTypedCommand(text, [], catalog))).toEqual([
      { type: "text", text },
    ]);
  expect(composerInput("/review", withTypedCommand("/review", [], undefined))).toEqual([
    { type: "text", text: "/review" },
  ]);
});
test("a chip already picked at the start is not duplicated", () => {
  const picked = tokensFromInput([writing, { type: "text", text: " /review" }]);
  expect(withTypedCommand(picked.text, picked.tokens, catalog)).toBe(picked.tokens);
});
