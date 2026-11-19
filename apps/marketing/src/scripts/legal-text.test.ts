import { expect, test } from "vitest";
import { textRuns } from "./legal-text.ts";

const email = "hello@example.com";

test("words in backticks are code and the rest is text, word for word", () => {
  expect(textRuns("Run `ace account login` on it.", email)).toEqual([
    { kind: "text", text: "Run " },
    { kind: "code", text: "ace account login" },
    { kind: "text", text: " on it." },
  ]);
});

test("the contact address becomes its own run, so it can be a mail link", () => {
  expect(textRuns(`Write to ${email}, or ${email}.`, email)).toEqual([
    { kind: "text", text: "Write to " },
    { kind: "email", text: email },
    { kind: "text", text: ", or " },
    { kind: "email", text: email },
    { kind: "text", text: "." },
  ]);
});

test("a paragraph without code or the address is one text run", () => {
  expect(textRuns("Plain words.", email)).toEqual([{ kind: "text", text: "Plain words." }]);
});
