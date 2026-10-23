import { expect, test } from "vitest";
import { Item, ThreadId } from "@ace/protocol";
import { inheritedDrafts, trimmedHistory, trimmedText } from "./index.ts";

const source = ThreadId.parse("source");
const copy = (items: Item[], trimmed = false) => inheritedDrafts(items, "root", source, trimmed);

let clock = 0;

function message(
  id: string,
  role: "user" | "assistant",
  parts: unknown[],
  extra: Record<string, unknown> = {},
) {
  return Item.parse({
    id,
    agentId: "root",
    type: "message",
    role,
    complete: true,
    createdAt: ++clock,
    parts,
    ...(role === "user" ? { origin: { kind: "person" } } : {}),
    ...extra,
  });
}
const text = (value: string) => ({ type: "text", text: value });
const words = (copied: ReturnType<typeof copy>) =>
  copied.flatMap(({ draft }) =>
    draft.type === "message"
      ? [
          [
            draft.role,
            draft.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
          ],
        ]
      : [],
  );

test("a fork copies the person's asks and the agent's answers, in order", () => {
  const copied = copy([
    message("ask", "user", [text("Document the router")]),
    message("answer", "assistant", [text("Here is the outline.")]),
    message("next", "user", [text("Add examples")], { origin: { kind: "steer" } }),
  ]);
  expect(words(copied)).toEqual([
    ["user", "Document the router"],
    ["assistant", "Here is the outline."],
    ["user", "Add examples"],
  ]);
  // Each says where and when it was said.
  expect(copied.map(({ draft }) => draft.type === "message" && draft.inherited)).toEqual([
    { threadId: source, itemId: "ask", at: clock - 2 },
    { threadId: source, itemId: "answer", at: clock - 1 },
    { threadId: source, itemId: "next", at: clock },
  ]);
});

test("ace's own inputs, injected messages and unfinished answers are not copied", () => {
  const copied = copy([
    message("ask", "user", [text("Fix the build")]),
    message("result", "user", [text("<subagent result>")], {
      origin: { kind: "subagent_result" },
    }),
    message("restart", "user", [text("Continue")], { origin: { kind: "restart" } }),
    message("injected", "user", [text("task notification")], {
      origin: undefined,
      synthetic: true,
    }),
    message("note", "assistant", [text("system note")], { synthetic: true }),
    message("streaming", "assistant", [text("Half an ans")], { complete: false }),
  ]);
  expect(words(copied)).toEqual([["user", "Fix the build"]]);
});

test("only the forked agent's conversation is copied, not its subagents'", () => {
  const copied = copy([
    message("ask", "user", [text("Plan it")]),
    message("child", "assistant", [text("child answer")], { agentId: "child" }),
    message("answer", "assistant", [text("The plan")]),
  ]);
  expect(words(copied)).toEqual([
    ["user", "Plan it"],
    ["assistant", "The plan"],
  ]);
});

test("an ask that carried an earlier handoff copies as the person's words alone", () => {
  const block =
    '<ace_context_handoff source_thread="older" through_seq="12">\nquoted history\n</ace_context_handoff>\n\n';
  const copied = copy([message("ask", "user", [text(`${block}What next?`)])]);
  expect(words(copied)).toEqual([["user", "What next?"]]);
});

test("attachments stay with the source; a message left with no words is skipped", () => {
  const copied = copy([
    message("shot", "user", [{ type: "image", mimeType: "image/png", url: "blob:1" }]),
    message("ask", "user", [text("See this file"), { type: "file", path: "/tmp/a.txt" }]),
  ]);
  expect(copied).toHaveLength(1);
  expect(copied[0]?.draft.type === "message" && copied[0].draft.parts).toEqual([
    { type: "text", text: "See this file" },
  ]);
});

test("a text cut to the copy's budget says the rest is in the source", () => {
  const cut = message("long", "assistant", [
    {
      type: "text",
      text: "x".repeat(10),
      source: { streamId: "s", bytes: 200, encoding: "utf-16le" },
    },
  ]);
  expect(words(copy([cut]))).toEqual([["assistant", `${"x".repeat(10)}${trimmedText}`]]);
});

test("when older messages stayed in the source, one note says so before the copies", () => {
  const copied = copy([message("ask", "user", [text("Plan it")])], true);
  expect(copied.map(({ draft }) => (draft.type === "notice" ? draft.text : draft.role))).toEqual([
    trimmedHistory,
    "user",
  ]);
});
