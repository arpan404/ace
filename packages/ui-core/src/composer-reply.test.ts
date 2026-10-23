import { Question, type Interaction } from "@ace/protocol";
import { expect, test } from "vitest";
import { composerReply } from "./composer-reply.ts";
import { emptyDraft, otherAnswer, type QuestionDraft } from "./question-draft.ts";

const indent = Question.parse({
  id: "indent",
  text: "Tabs or Spaces?",
  allowOther: true,
  options: [
    { id: "tabs", label: "Tabs" },
    { id: "spaces", label: "Spaces" },
  ],
});
const quotes = Question.parse({
  id: "quotes",
  text: "Which quotes?",
  allowOther: true,
  options: [{ id: "double", label: "Double" }],
});
const files = Question.parse({
  id: "files",
  text: "Which files?",
  multiSelect: true,
  allowOther: true,
  options: [
    { id: "ts", label: "TypeScript" },
    { id: "css", label: "CSS" },
  ],
});
const strict = Question.parse({
  id: "strict",
  text: "Turn on strict mode?",
  options: [
    { id: "yes", label: "Yes" },
    { id: "no", label: "No" },
  ],
});

type Asked = Pick<Interaction, "state" | "blocking" | "request">;
const asking = (questions: Question[], extra: Partial<Asked> = {}): Asked => ({
  state: "pending",
  blocking: true,
  request: { kind: "question", questions },
  ...extra,
});
const draft = (change: Partial<QuestionDraft>): QuestionDraft => ({ ...emptyDraft, ...change });

test("the words answer the question on screen and every one not answered yet", () => {
  expect(composerReply(asking([indent, quotes]), emptyDraft, "  Match the repo  ")).toEqual({
    kind: "question",
    answers: { indent: ["Match the repo"], quotes: ["Match the repo"] },
  });
});

test("picks made on the card stay; the question on screen takes the words", () => {
  const made = draft({ picked: { indent: ["spaces"] }, at: 1 });
  expect(composerReply(asking([indent, quotes]), made, "Single")).toEqual({
    kind: "question",
    answers: { indent: ["spaces"], quotes: ["Single"] },
  });
});

test("on a question taking several answers, the words join what was picked", () => {
  const made = draft({ picked: { files: ["ts", otherAnswer] }, texts: { files: "" } });
  expect(composerReply(asking([files]), made, "Markdown")).toEqual({
    kind: "question",
    answers: { files: ["ts", "Markdown"] },
  });
});

test("a single pick on the question on screen gives way to the words", () => {
  const made = draft({ picked: { indent: ["tabs"] } });
  expect(composerReply(asking([indent]), made, "Two spaces")).toEqual({
    kind: "question",
    answers: { indent: ["Two spaces"] },
  });
});

test("the message stays a message when a question still unanswered takes no free text", () => {
  expect(composerReply(asking([indent, strict]), emptyDraft, "Spaces")).toBeUndefined();
  expect(composerReply(asking([strict]), emptyDraft, "Yes please")).toBeUndefined();
  // Answered on the card, it no longer stands in the way.
  const made = draft({ picked: { strict: ["yes"] } });
  expect(composerReply(asking([indent, strict]), made, "Spaces")).toEqual({
    kind: "question",
    answers: { indent: ["Spaces"], strict: ["yes"] },
  });
});

test("only a question the agent waits on is answered, and only with words", () => {
  expect(composerReply(asking([indent], { blocking: false }), emptyDraft, "Tabs")).toBeUndefined();
  expect(
    composerReply(asking([indent], { state: "resolved" }), emptyDraft, "Tabs"),
  ).toBeUndefined();
  expect(composerReply(asking([indent]), emptyDraft, "   ")).toBeUndefined();
  expect(composerReply(undefined, emptyDraft, "Tabs")).toBeUndefined();
});
