import { expect, test } from "vitest";
import { Item } from "@ace/protocol";
import { inheritedMessages } from "./index.ts";

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
const words = (copied: ReturnType<typeof inheritedMessages>) =>
  copied.map((entry) => [
    entry.role,
    entry.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
  ]);

test("a fork copies the person's asks and the agent's answers, in order", () => {
  const copied = inheritedMessages(
    [
      message("ask", "user", [text("Document the router")]),
      message("answer", "assistant", [text("Here is the outline.")]),
      message("next", "user", [text("Add examples")], { origin: { kind: "steer" } }),
    ],
    "root",
  );
  expect(words(copied)).toEqual([
    ["user", "Document the router"],
    ["assistant", "Here is the outline."],
    ["user", "Add examples"],
  ]);
  expect(copied.map((entry) => entry.itemId)).toEqual(["ask", "answer", "next"]);
});

test("ace's own inputs, injected messages and unfinished answers are not copied", () => {
  const copied = inheritedMessages(
    [
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
    ],
    "root",
  );
  expect(words(copied)).toEqual([["user", "Fix the build"]]);
});

test("only the forked agent's conversation is copied, not its subagents'", () => {
  const copied = inheritedMessages(
    [
      message("ask", "user", [text("Plan it")]),
      message("child", "assistant", [text("child answer")], { agentId: "child" }),
      message("answer", "assistant", [text("The plan")]),
    ],
    "root",
  );
  expect(words(copied)).toEqual([
    ["user", "Plan it"],
    ["assistant", "The plan"],
  ]);
});

test("an ask that carried an earlier handoff copies as the person's words alone", () => {
  const block =
    '<ace_context_handoff source_thread="older" through_seq="12">\nquoted history\n</ace_context_handoff>\n\n';
  const copied = inheritedMessages([message("ask", "user", [text(`${block}What next?`)])], "root");
  expect(words(copied)).toEqual([["user", "What next?"]]);
});

test("attachments stay with the source; a message left with no words is skipped", () => {
  const copied = inheritedMessages(
    [
      message("shot", "user", [{ type: "image", mimeType: "image/png", url: "blob:1" }]),
      message("ask", "user", [text("See this file"), { type: "file", path: "/tmp/a.txt" }]),
    ],
    "root",
  );
  expect(copied).toHaveLength(1);
  expect(copied[0]?.parts).toEqual([{ type: "text", text: "See this file" }]);
});
